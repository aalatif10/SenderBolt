-- Per-user settings. default_signature_html is used for any sender account that has no signature of its own.
CREATE TABLE user_settings (
  user_id                INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  default_signature_html TEXT,
  updated_at             INTEGER NOT NULL
);
