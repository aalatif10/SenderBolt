-- SenderBolt initial schema. Timestamps are epoch milliseconds (INTEGER).
-- Every owned table carries user_id so the app can become multi-tenant later.
-- Constraints are a second line of defence behind application validation.

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','member')),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,       -- sha256 of the cookie token; raw token is never stored
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, created_at);
CREATE INDEX idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  INTEGER,
  ip         TEXT,
  meta       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_user_time ON audit_log(user_id, created_at);

CREATE TABLE senders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label            TEXT NOT NULL,
  email            TEXT NOT NULL COLLATE NOCASE,
  provider         TEXT NOT NULL CHECK (provider IN ('gmail','smtp')),
  username         TEXT NOT NULL,
  password_enc     TEXT NOT NULL,           -- AES-256-GCM ciphertext (see lib/vault.js)
  smtp_host        TEXT NOT NULL,
  smtp_port        INTEGER NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
  smtp_secure      INTEGER NOT NULL DEFAULT 1 CHECK (smtp_secure IN (0,1)),
  imap_host        TEXT,
  imap_port        INTEGER CHECK (imap_port IS NULL OR imap_port BETWEEN 1 AND 65535),
  from_name        TEXT,
  daily_limit      INTEGER NOT NULL DEFAULT 50 CHECK (daily_limit BETWEEN 1 AND 500),
  delay_mode       TEXT NOT NULL DEFAULT 'random' CHECK (delay_mode IN ('fixed','random')),
  delay_fixed_sec  INTEGER NOT NULL DEFAULT 60  CHECK (delay_fixed_sec BETWEEN 1 AND 3600),
  delay_min_sec    INTEGER NOT NULL DEFAULT 45  CHECK (delay_min_sec BETWEEN 1 AND 3600),
  delay_max_sec    INTEGER NOT NULL DEFAULT 120 CHECK (delay_max_sec BETWEEN 1 AND 3600),
  warmup_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (warmup_enabled IN (0,1)),
  warmup_started_at INTEGER,
  health_score     INTEGER NOT NULL DEFAULT 100 CHECK (health_score BETWEEN 0 AND 100),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  signature_html   TEXT,
  tracking_domain  TEXT,
  sent_today       INTEGER NOT NULL DEFAULT 0,
  sent_today_date  TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK (delay_min_sec <= delay_max_sec),
  UNIQUE (user_id, email)
);

CREATE TABLE folders (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id     INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  email         TEXT NOT NULL COLLATE NOCASE,
  domain        TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  company       TEXT,
  custom        TEXT,                        -- JSON object of extra merge fields
  is_role       INTEGER NOT NULL DEFAULT 0,
  verify_status TEXT NOT NULL DEFAULT 'unverified'
                CHECK (verify_status IN ('unverified','valid','invalid','catch_all','risky')),
  verify_error  TEXT,
  verified_at   INTEGER,
  created_at    INTEGER NOT NULL,
  UNIQUE (folder_id, email)
);
CREATE INDEX idx_leads_folder ON leads(user_id, folder_id);
CREATE INDEX idx_leads_domain ON leads(user_id, domain);

CREATE TABLE suppression (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email      TEXT NOT NULL COLLATE NOCASE,
  reason     TEXT NOT NULL CHECK (reason IN ('unsubscribed','bounced','complaint','manual','replied_stop')),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, email)
);

-- A main campaign has parent_id NULL; sub-campaigns point at their main campaign.
CREATE TABLE campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id   INTEGER REFERENCES campaigns(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','preparing','active','paused','completed','error')),
  split_seed  INTEGER,
  batch_size  INTEGER CHECK (batch_size IS NULL OR batch_size >= 1),
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_campaigns_user_status ON campaigns(user_id, status);
CREATE INDEX idx_campaigns_parent ON campaigns(parent_id);

CREATE TABLE campaign_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_no     INTEGER NOT NULL CHECK (step_no BETWEEN 0 AND 5),   -- 0 = first email, 1..5 = follow-ups
  delay_days  INTEGER NOT NULL DEFAULT 0 CHECK (delay_days BETWEEN 0 AND 60),
  subject     TEXT NOT NULL,
  body_html   TEXT NOT NULL,
  UNIQUE (campaign_id, step_no)
);

CREATE TABLE campaign_senders (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sender_id   INTEGER NOT NULL REFERENCES senders(id) ON DELETE RESTRICT,
  PRIMARY KEY (campaign_id, sender_id)
);

CREATE TABLE campaign_leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sender_id    INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','active','replied','completed','bounced','unsubscribed','paused','error')),
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER,
  last_sent_at INTEGER,
  UNIQUE (campaign_id, lead_id)
);
CREATE INDEX idx_cl_due ON campaign_leads(next_send_at) WHERE status = 'active';

CREATE TABLE messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_lead_id INTEGER REFERENCES campaign_leads(id) ON DELETE SET NULL,
  sender_id        INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  lead_id          INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  direction        TEXT NOT NULL CHECK (direction IN ('out','in')),
  status           TEXT NOT NULL DEFAULT 'queued'
                   CHECK (status IN ('queued','sending','sent','failed','received')),
  idempotency_key  TEXT UNIQUE,              -- campaign_lead_id:step so a crash can never double-send
  message_id_hdr   TEXT,
  in_reply_to      TEXT,
  subject          TEXT,
  body_html        TEXT,                     -- stored raw; ALWAYS sanitize on render
  body_text        TEXT,
  sentiment        TEXT CHECK (sentiment IS NULL OR sentiment IN ('interested','more_info','not_interested','neutral','out_of_office')),
  error            TEXT,
  sent_at          INTEGER,
  received_at      INTEGER,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_messages_cl ON messages(campaign_lead_id);
CREATE INDEX idx_messages_inbox ON messages(user_id, direction, received_at);
CREATE INDEX idx_messages_hdr ON messages(message_id_hdr);
