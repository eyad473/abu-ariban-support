// ============================================================
// موقع الدعم الفني — مخيم أبو عريبان (نسخة Cloudflare)
// نفس تدفق العمل الأصلي: تحقق هوية بسؤال أمني -> تقديم طلب -> يوصل
// لتلغرام الإدارة -> ردهم بالـ Reply يوصل تلقائيًا لصاحب الطلب.
// ============================================================

const SESSION_MINUTES = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function generateRequestCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function extractYear(v) {
  const m = String(v || "").match(/\d{4}/);
  return m ? m[0] : null;
}

// ---------- إعدادات (مجموعة الإدارة) محفوظة بجدول support_settings ----------
async function getSetting(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM support_settings WHERE key=?`).bind(key).first();
  return row ? row.value : null;
}
async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO support_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  )
    .bind(key, value)
    .run();
}

// ---------- تلغرام (اختياري تمامًا — لو ما في توكن مضبوط، نتجاهله بهدوء بدون ما نكسر الطلب) ----------
async function tgCall(env, method, payload) {
  if (!env.TELEGRAM_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  } catch (e) {
    return null;
  }
}
async function notifyOwner(env, text) {
  try {
    await tgCall(env, "sendMessage", { chat_id: env.TELEGRAM_OWNER_CHAT_ID, text });
  } catch (e) {}
}
async function sendToAdminGroup(env, text) {
  const groupId = (await getSetting(env, "admin_group_id")) || env.TELEGRAM_OWNER_CHAT_ID;
  return tgCall(env, "sendMessage", { chat_id: groupId, text });
}

// ---------- منع محاولات متكررة حسب IP ----------
async function isIpBlocked(env, ip) {
  const row = await env.DB.prepare(`SELECT blocked_until FROM support_failed_attempts WHERE ip=?`).bind(ip).first();
  return !!(row && row.blocked_until && new Date(row.blocked_until) > new Date());
}
async function recordFailedAttempt(env, ip) {
  const row = await env.DB.prepare(`SELECT count FROM support_failed_attempts WHERE ip=?`).bind(ip).first();
  const count = (row ? row.count : 0) + 1;
  const blockedUntil = count >= 5 ? new Date(Date.now() + 3600000).toISOString() : null;
  await env.DB.prepare(
    `INSERT INTO support_failed_attempts (ip, count, blocked_until, last_attempt_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(ip) DO UPDATE SET count=?, blocked_until=?, last_attempt_at=datetime('now')`
  )
    .bind(ip, count >= 5 ? 0 : count, blockedUntil, count >= 5 ? 0 : count, blockedUntil)
    .run();
}
async function clearFailedAttempts(env, ip) {
  await env.DB.prepare(`DELETE FROM support_failed_attempts WHERE ip=?`).bind(ip).run();
}

// ---------- أسئلة التحقق: من بيانات العائلة الموجودة أصلًا بقاعدة التطبيق الموحد (حتى 3 أسئلة) ----------
async function pickVerificationQuestions(env, family) {
  const members = (
    await env.DB.prepare(`SELECT full_name, birth_year, relation FROM family_members WHERE family_id=? AND birth_year IS NOT NULL`)
      .bind(family.id)
      .all()
  ).results;

  const questions = [];
  const shuffledMembers = [...members].sort(() => Math.random() - 0.5);
  for (const m of shuffledMembers) {
    if (questions.length >= 2) break; // نسيب مكان لسؤال ثالث متنوع (رقم الهاتف أو عدد الأفراد)
    const label = m.relation === "زوجة" ? "زوجة رب الأسرة" : m.full_name;
    questions.push({ type: "birthyear", prompt: `ما هي سنة ميلاد ${label}؟`, answer: String(m.birth_year) });
  }
  if (family.member_count && questions.length < 3) {
    questions.push({ type: "member_count", prompt: "كم عدد أفراد أسرتك بالضبط (حسب سجل النزوح)؟", answer: String(family.member_count) });
  }
  if (family.phone_last4 && questions.length < 3) {
    questions.push({ type: "phone", prompt: "ما هي آخر 4 أرقام من رقم الجوال المسجل لدى العائلة؟", answer: family.phone_last4 });
  }
  return questions.sort(() => Math.random() - 0.5).slice(0, 3);
}
function checkAnswer(question, userText) {
  const digits = (String(userText).match(/\d+/g) || []).join("");
  if (question.type === "birthyear") return extractYear(userText) === question.answer;
  if (question.type === "member_count") return digits === question.answer;
  if (question.type === "phone") return digits.endsWith(question.answer);
  return false;
}

// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";

    try {
      // ---------------- إعلان عام ----------------
      if (path === "/api/announcement" && method === "GET") {
        const row = await env.DB.prepare(`SELECT text FROM support_announcement WHERE id=1`).first();
        return json({ announcement: row ? { text: row.text } : null });
      }

      // ---------------- حالة النظام ----------------
      if (path === "/status" && method === "GET") {
        const families = await env.DB.prepare(`SELECT COUNT(*) c FROM families`).first();
        const requests = await env.DB.prepare(`SELECT COUNT(*) c FROM support_requests`).first();
        const groupId = await getSetting(env, "admin_group_id");
        return json({ ok: true, families: families.c, requests: requests.c, admin_group_set: !!groupId });
      }

      // ---------------- الخطوة 1: التحقق من رقم الهوية ----------------
      if (path === "/api/verify-id" && method === "POST") {
        if (await isIpBlocked(env, ip)) {
          return json({ ok: false, message: "تم حظر المحاولات مؤقتًا لمدة ساعة بسبب محاولات متكررة خاطئة. تواصل مع مكتب إدارة المخيم مباشرة." });
        }
        const { id } = await request.json();
        const idRaw = String(id || "").replace(/\D/g, "");
        if (idRaw.length < 7) return json({ ok: false, message: "رقم الهوية غير صحيح." });

        const family = await env.DB.prepare(`SELECT * FROM families WHERE national_id=?`).bind(idRaw).first();
        if (!family) {
          await recordFailedAttempt(env, ip);
          return json({ ok: false, message: "لم يتم العثور على رقم الهوية هذا بالسجل. تأكد من الرقم وحاول مجددًا." });
        }
        await clearFailedAttempts(env, ip);

        const questions = await pickVerificationQuestions(env, family);
        const token = newToken();
        const expires = new Date(Date.now() + SESSION_MINUTES * 60000).toISOString();

        await env.DB.prepare(
          `INSERT INTO support_sessions (token, family_id, family_name, state, questions, q_index, expires_at) VALUES (?, ?, ?, ?, ?, 0, ?)`
        )
          .bind(token, family.id, family.head_name, questions.length ? "verifying" : "active", JSON.stringify(questions), expires)
          .run();

        if (questions.length === 0) {
          await logAccess(env, family.id, family.head_name, ip);
          await notifyOwner(env, `✅ تحقق بنجاح (بدون سؤال - لا بيانات كافية):\n${family.head_name}`);
          return json({ ok: true, token, verified: true, familyName: family.head_name });
        }
        return json({ ok: true, token, verified: false, question: questions[0].prompt, qIndex: 0, total: questions.length });
      }

      // ---------------- الخطوة 2: الإجابة على سؤال التحقق ----------------
      if (path === "/api/verify-answer" && method === "POST") {
        const { token, answer } = await request.json();
        const session = await env.DB.prepare(`SELECT * FROM support_sessions WHERE token=?`).bind(token).first();
        if (!session || session.state !== "verifying" || new Date(session.expires_at) < new Date()) {
          return json({ ok: false, message: "جلسة غير صالحة، يرجى البدء من جديد." });
        }
        if (await isIpBlocked(env, ip)) {
          return json({ ok: false, message: "تم حظر المحاولات مؤقتًا لمدة ساعة. تواصل مع مكتب إدارة المخيم مباشرة." });
        }

        const questions = JSON.parse(session.questions);
        const q = questions[session.q_index];
        const correct = checkAnswer(q, String(answer || ""));
        if (!correct) {
          await recordFailedAttempt(env, ip);
          return json({ ok: false, message: "إجابة غير صحيحة، حاول مجددًا.", question: q.prompt });
        }

        const nextIndex = session.q_index + 1;
        if (nextIndex >= questions.length) {
          await env.DB.prepare(`UPDATE support_sessions SET state='active', q_index=? WHERE token=?`).bind(nextIndex, token).run();
          await logAccess(env, session.family_id, session.family_name, ip);
          await notifyOwner(env, `✅ تحقق بنجاح:\n${session.family_name}`);
          return json({ ok: true, verified: true, familyName: session.family_name });
        }
        await env.DB.prepare(`UPDATE support_sessions SET q_index=? WHERE token=?`).bind(nextIndex, token).run();
        return json({ ok: true, verified: false, question: questions[nextIndex].prompt, qIndex: nextIndex, total: questions.length });
      }

      // ---------------- بيانات العائلة المسجلة ----------------
      if (path === "/api/my-data" && method === "GET") {
        const session = await activeSession(env, url.searchParams.get("token"));
        if (!session) return json({ ok: false, message: "انتهت صلاحية الجلسة، رجاءً سجّل من جديد برقم هويتك" }, 401);
        const family = await env.DB.prepare(`SELECT * FROM families WHERE id=?`).bind(session.family_id).first();
        const members = await env.DB.prepare(`SELECT full_name, relation FROM family_members WHERE family_id=?`).bind(session.family_id).all();
        const distributions = await env.DB.prepare(
          `SELECT item_name, quantity, source_org, distribution_date FROM distributions WHERE family_id=? ORDER BY distribution_date DESC LIMIT 50`
        ).bind(session.family_id).all();
        return json({
          ok: true,
          fields: [
            { label: "رب الأسرة", value: family.head_name },
            { label: "عدد الأفراد", value: String(family.member_count) },
            { label: "الموقع الحالي", value: family.current_location || "—" },
            { label: "منطقة الأصل", value: family.origin_area || "—" },
            { label: "الحالة", value: family.status },
            ...members.results.map((m) => ({ label: m.relation || "فرد", value: m.full_name })),
          ],
          distributions: distributions.results,
        });
      }

      // ---------------- تقديم طلب جديد ----------------
      if (path === "/api/submit-request" && method === "POST") {
        const body = await request.json();
        const session = await activeSession(env, body.token);
        if (!session) return json({ ok: false, message: "انتهت صلاحية الجلسة، رجاءً سجّل من جديد برقم هويتك" }, 401);

        const category = String(body.category || "").trim();
        const detailsText = String(body.details || "").trim();
        if (!category) return json({ ok: false, message: "نوع الطلب مطلوب." });
        if (!detailsText) return json({ ok: false, message: "أرسل تفاصيل الطلب من فضلك." });

        let requestCode;
        do {
          requestCode = generateRequestCode();
        } while (await env.DB.prepare(`SELECT 1 FROM support_requests WHERE request_code=?`).bind(requestCode).first());

        const text = `📋 طلب جديد - ${category}\n👤 الاسم: ${session.family_name}\n🔖 رقم الطلب: ${requestCode}\n—\n💬 التفاصيل:\n${detailsText}\n\n(للرد: اعمل Reply على هذه الرسالة)`;
        const sent = await sendToAdminGroup(env, text);
        const msgId = sent && sent.result ? String(sent.result.message_id) : null;

        await env.DB.prepare(
          `INSERT INTO support_requests (request_code, family_id, category, details_text, telegram_msg_id) VALUES (?, ?, ?, ?, ?)`
        )
          .bind(requestCode, session.family_id, category, detailsText, msgId)
          .run();

        return json({ ok: true, requestCode });
      }

      // ---------------- طلبات العائلة كلها ----------------
      if (path === "/api/my-requests" && method === "GET") {
        const session = await activeSession(env, url.searchParams.get("token"));
        if (!session) return json({ ok: false, message: "انتهت صلاحية الجلسة، رجاءً سجّل من جديد برقم هويتك" }, 401);
        const rows = await env.DB.prepare(
          `SELECT request_code, category, details_text, reply, seen, created_at FROM support_requests WHERE family_id=? ORDER BY created_at DESC`
        )
          .bind(session.family_id)
          .all();
        return json({
          ok: true,
          requests: rows.results.map((r) => ({
            requestCode: r.request_code,
            category: r.category,
            detailsText: r.details_text,
            reply: r.reply,
            unseen: !!r.reply && !r.seen,
            createdAt: r.created_at,
          })),
        });
      }

      // ---------------- تعليم كمقروء ----------------
      if (path === "/api/mark-seen" && method === "POST") {
        const body = await request.json();
        const session = await activeSession(env, body.token);
        if (!session) return json({ ok: false, message: "انتهت صلاحية الجلسة، رجاءً سجّل من جديد برقم هويتك" }, 401);
        await env.DB.prepare(`UPDATE support_requests SET seen=1 WHERE request_code=? AND family_id=?`)
          .bind(body.requestCode, session.family_id)
          .run();
        return json({ ok: true });
      }

      // ---------------- تفقد حالة طلب (بدون تسجيل دخول، برقم الهوية + رقم الطلب) ----------------
      if (path === "/api/check-status" && method === "GET") {
        const idRaw = String(url.searchParams.get("id") || "").replace(/\D/g, "");
        const code = url.searchParams.get("code") || "";
        const row = await env.DB.prepare(
          `SELECT sr.category, sr.details_text, sr.reply, sr.created_at FROM support_requests sr
           JOIN families f ON f.id = sr.family_id WHERE sr.request_code=? AND f.national_id=?`
        )
          .bind(code, idRaw)
          .first();
        if (!row) return json({ ok: false, message: "لم يتم العثور على طلب بهذا الرقم وهذه الهوية." });
        return json({ ok: true, category: row.category, detailsText: row.details_text, reply: row.reply, createdAt: row.created_at });
      }

      // ---------------- Webhook تلغرام ----------------
      if (path === "/telegram-webhook" && method === "POST") {
        const update = await request.json();
        await handleTelegramUpdate(env, update);
        return json({ ok: true });
      }

      if (path.startsWith("/api/")) return json({ ok: false, error: "مسار غير موجود" }, 404);

      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ ok: false, error: "خطأ داخلي: " + e.message }, 500);
    }
  },
};

async function logAccess(env, familyId, familyName, ip) {
  try {
    await env.DB.prepare(`INSERT INTO support_access_log (family_id, family_name, ip) VALUES (?, ?, ?)`)
      .bind(familyId, familyName, ip)
      .run();
  } catch (e) {}
}

async function activeSession(env, token) {
  if (!token) return null;
  const s = await env.DB.prepare(`SELECT * FROM support_sessions WHERE token=? AND state='active'`).bind(token).first();
  if (!s || new Date(s.expires_at) < new Date()) return null;
  return s;
}

// ============================================================
// معالجة تحديثات تلغرام (بديل عن polling)
// ============================================================
async function handleTelegramUpdate(env, update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const isOwner = chatId === String(env.TELEGRAM_OWNER_CHAT_ID);
  const text = (msg.text || "").trim();

  // /setgroup — من داخل مجموعة الإدارة نفسها
  if (/^\/setgroup$/i.test(text)) {
    await setSetting(env, "admin_group_id", chatId);
    await tgCall(env, "sendMessage", { chat_id: chatId, text: "✅ تم تحديد هذه المجموعة كمستقبل رسمي لطلبات مخيم أبو عريبان." });
    return;
  }

  if (isOwner && /^\/start$/i.test(text)) {
    await tgCall(env, "sendMessage", { chat_id: chatId, text: "🤖 أهلاً! بوت دعم مخيم أبو عريبان (نسخة Cloudflare) شغال.\n/help لعرض الأوامر." });
    return;
  }

  if (isOwner && /^\/help$/i.test(text)) {
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text:
        "🤖 أوامر بوت دعم المخيم:\n" +
        "/setgroup — تحديد مجموعة استقبال الطلبات (تُكتب من داخل المجموعة)\n" +
        "/stats — إحصائيات سريعة\n" +
        "/help — عرض هذه القائمة\n\n" +
        "💡 للرد على أي طلب: اعمل Reply على رسالة الطلب، وبيوصل ردك فورًا لصاحب الطلب.\n\n" +
        "⚠️ ملاحظة: أوامر إدارة السجل المتقدمة (بحث بالاسم، تعديل بيانات، إضافة/حذف أشخاص، استيراد/تصدير Excel، الإعلانات) لسا مش موجودة بهاي النسخة — إدارة العائلات صارت من لوحة المناديب (admin.html) بدل تلغرام.",
    });
    return;
  }

  if (isOwner && /^\/stats$/i.test(text)) {
    const families = await env.DB.prepare(`SELECT COUNT(*) c FROM families`).first();
    const requests = await env.DB.prepare(`SELECT COUNT(*) c FROM support_requests`).first();
    const open = await env.DB.prepare(`SELECT COUNT(*) c FROM support_requests WHERE reply IS NULL`).first();
    const groupId = await getSetting(env, "admin_group_id");
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: `📊 عدد العائلات: ${families.c}\nإجمالي الطلبات: ${requests.c}\nطلبات بدون رد: ${open.c}\nمجموعة الإدارة: ${groupId || "غير محددة ⚠️"}`,
    });
    return;
  }

  // رد على طلب (Reply على رسالة الطلب الأصلية)
  if (!msg.reply_to_message) return;
  const repliedMsgId = String(msg.reply_to_message.message_id);
  const request = await env.DB.prepare(`SELECT * FROM support_requests WHERE telegram_msg_id=?`).bind(repliedMsgId).first();
  if (!request) return;

  const replyText = msg.text || msg.caption || "(تم الرد بمرفق)";
  await env.DB.prepare(`UPDATE support_requests SET reply=?, seen=0, replied_at=datetime('now') WHERE id=?`)
    .bind(replyText, request.id)
    .run();

  const family = await env.DB.prepare(`SELECT phone FROM families WHERE id=?`).bind(request.family_id).first();
  if (family && family.phone) {
    const digits = family.phone.replace(/\D/g, "");
    const waText = `مرحبًا،\nبخصوص طلبك رقم *${request.request_code}*:\n${replyText}`;
    await tgCall(env, "sendMessage", {
      chat_id: chatId,
      text: `اضغط لفتح واتساب وإرسال الرد:`,
      reply_markup: { inline_keyboard: [[{ text: "📱 إرسال عبر واتساب", url: `https://wa.me/${digits}?text=${encodeURIComponent(waText)}` }]] },
    });
  } else {
    await tgCall(env, "sendMessage", { chat_id: chatId, text: "✅ تم حفظ الرد. ما في رقم جوال مسجل — العائلة بتشوف الرد لو رجعت تتفقد بنفسها." });
  }
}
