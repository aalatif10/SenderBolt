-- v1.1: Campaign Studio, Reports, inline images, settings preferences.

-- Open tracking drill-down: every pixel hit already bumps open_count; now we also remember WHEN the last one happened.
ALTER TABLE messages ADD COLUMN last_opened_at INTEGER;
UPDATE messages SET last_opened_at = opened_at WHERE open_count > 0 AND opened_at IS NOT NULL;

-- Reports query "what was sent / opened in this period" per user.
CREATE INDEX idx_messages_user_sent ON messages(user_id, direction, sent_at);
CREATE INDEX idx_messages_opened ON messages(user_id, opened_at) WHERE open_count > 0;

-- Inline images (logos, small pictures). Stored once, referenced from email HTML as  sbimg:<id>  and delivered as
-- embedded (CID) MIME parts, so recipients never need to load anything from our server and nothing can be hot-linked.
CREATE TABLE email_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/gif','image/webp')),
  width      INTEGER NOT NULL CHECK (width BETWEEN 1 AND 10000),
  height     INTEGER NOT NULL CHECK (height BETWEEN 1 AND 10000),
  size       INTEGER NOT NULL CHECK (size BETWEEN 1 AND 409600),
  sha256     TEXT NOT NULL,
  data       BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, sha256)
);
CREATE INDEX idx_email_images_user ON email_images(user_id, created_at);

-- System preferences (JSON, whitelisted and validated by the settings service): defaults for new campaigns.
ALTER TABLE user_settings ADD COLUMN prefs TEXT;
