-- Projects (parent container for campaigns) + hard daily cap lowered to 400/day.

-- The original CHECK allows up to 500 and SQLite cannot alter a CHECK in place, so the new cap is
-- enforced by triggers (plus service validation). Existing senders above 400 are clamped.
UPDATE senders SET daily_limit = 400 WHERE daily_limit > 400;
CREATE TRIGGER senders_cap_insert BEFORE INSERT ON senders WHEN NEW.daily_limit > 400
BEGIN SELECT RAISE(ABORT, 'daily_limit cannot exceed 400'); END;
CREATE TRIGGER senders_cap_update BEFORE UPDATE OF daily_limit ON senders WHEN NEW.daily_limit > 400
BEGIN SELECT RAISE(ABORT, 'daily_limit cannot exceed 400'); END;

CREATE TABLE projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_projects_user ON projects(user_id, archived);

-- Only MAIN campaigns (parent_id IS NULL) carry a project; split parts belong through their main campaign.
-- RESTRICT: a project can never disappear underneath its campaigns (the service deletes campaigns first).
ALTER TABLE campaigns ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE RESTRICT;
CREATE INDEX idx_campaigns_project ON campaigns(project_id);

-- Existing campaigns each get a project of their own (same id, so the link needs no guesswork).
INSERT INTO projects (id, user_id, name, created_at, updated_at)
  SELECT id, user_id, name, created_at, updated_at FROM campaigns WHERE parent_id IS NULL ORDER BY id;
UPDATE campaigns SET project_id = id WHERE parent_id IS NULL;
