-- ============================================================
-- إضافات موقع الدعم الفني — تُنفَّذ على نفس قاعدة abu-ariban-db
-- (بعد جداول schema.sql الأساسية)
-- ============================================================

-- طلبات الدعم (شكاوى / ملاحظات / استفسارات / مشاكل) المقدمة من العائلات
CREATE TABLE IF NOT EXISTS support_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_code TEXT UNIQUE NOT NULL,
  family_id INTEGER NOT NULL REFERENCES families(id),
  category TEXT NOT NULL,
  details_text TEXT,
  reply TEXT,
  seen INTEGER DEFAULT 1,
  telegram_msg_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  replied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_requests_family ON support_requests(family_id);
CREATE INDEX IF NOT EXISTS idx_support_requests_msgid ON support_requests(telegram_msg_id);

-- جلسات التحقق المؤقتة (بدل الجلسات بالذاكرة بالنسخة القديمة)
CREATE TABLE IF NOT EXISTS support_sessions (
  token TEXT PRIMARY KEY,
  family_id INTEGER NOT NULL REFERENCES families(id),
  family_name TEXT,
  state TEXT NOT NULL,           -- verifying | active
  questions TEXT,                 -- JSON: [{type, prompt, answer}]
  q_index INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

-- إعدادات الموقع (مجموعة تلغرام الإدارة...)
CREATE TABLE IF NOT EXISTS support_settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- منع محاولات التخمين المتكررة (حسب IP)
CREATE TABLE IF NOT EXISTS support_failed_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  blocked_until TEXT,
  last_attempt_at TEXT
);

-- إعلان عام يظهر لكل زوار الموقع (صف واحد فقط)
CREATE TABLE IF NOT EXISTS support_announcement (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  text TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
