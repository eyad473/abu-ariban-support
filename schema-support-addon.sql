-- نفّذ هذا وحده بالـ D1 Console (إضافة بسيطة لما نفذته سابقًا من schema-support.sql)

CREATE TABLE IF NOT EXISTS support_access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id INTEGER NOT NULL REFERENCES families(id),
  family_name TEXT,
  ip TEXT,
  verified_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_access_family ON support_access_log(family_id);
