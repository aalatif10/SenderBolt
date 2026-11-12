-- Campaign Builder drafts: the wizard autosaves here so nothing typed is ever lost.
-- `data` is a normalised JSON snapshot of the wizard (see services/drafts.js); it is NOT a campaign
-- (no leads are reserved, nothing can be sent). `rev` increases on every save and protects against
-- two browser tabs overwriting each other.
CREATE TABLE wizard_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_wizard_drafts_user ON wizard_drafts(user_id, updated_at);
