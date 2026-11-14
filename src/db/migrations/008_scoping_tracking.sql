-- Project scoping enforced IN THE DATABASE + open-tracking columns.
--   * a MAIN campaign (parent_id IS NULL) always belongs to exactly one of the same user's projects;
--   * a split PART never carries a project (it belongs through its main campaign);
--   * a campaign can never be moved to another user's project or detached from its project.

-- Repair: any main campaign that somehow has no project gets one of its own.
INSERT INTO projects (user_id, name, created_at, updated_at)
  SELECT user_id, name, created_at, updated_at FROM campaigns WHERE parent_id IS NULL AND project_id IS NULL ORDER BY id;
UPDATE campaigns SET project_id = (SELECT p.id FROM projects p WHERE p.user_id = campaigns.user_id AND p.name = campaigns.name ORDER BY p.id DESC LIMIT 1)
  WHERE parent_id IS NULL AND project_id IS NULL;
UPDATE campaigns SET project_id = NULL WHERE parent_id IS NOT NULL AND project_id IS NOT NULL;

-- Safety net: a main campaign inserted without a project is never left "loose".
CREATE TRIGGER campaigns_main_needs_project AFTER INSERT ON campaigns WHEN NEW.parent_id IS NULL AND NEW.project_id IS NULL
BEGIN
  INSERT INTO projects (user_id, name, created_at, updated_at) VALUES (NEW.user_id, NEW.name, NEW.created_at, NEW.updated_at);
  UPDATE campaigns SET project_id = last_insert_rowid() WHERE id = NEW.id;
END;
CREATE TRIGGER campaigns_part_no_project_ins BEFORE INSERT ON campaigns WHEN NEW.parent_id IS NOT NULL AND NEW.project_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'a split part belongs to its main campaign, not to a project'); END;
CREATE TRIGGER campaigns_project_owner_ins BEFORE INSERT ON campaigns WHEN NEW.project_id IS NOT NULL AND (SELECT user_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.user_id
BEGIN SELECT RAISE(ABORT, 'project belongs to another user'); END;
CREATE TRIGGER campaigns_project_upd BEFORE UPDATE OF project_id, parent_id ON campaigns
WHEN (NEW.parent_id IS NULL AND NEW.project_id IS NULL) OR (NEW.parent_id IS NOT NULL AND NEW.project_id IS NOT NULL)
  OR (NEW.project_id IS NOT NULL AND (SELECT user_id FROM projects WHERE id = NEW.project_id) IS NOT NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'invalid project assignment'); END;

-- Open tracking (opt-in per campaign). Counts are approximate by nature (image blocking, mail-client prefetch).
ALTER TABLE messages ADD COLUMN opened_at INTEGER;
ALTER TABLE messages ADD COLUMN open_count INTEGER NOT NULL DEFAULT 0;
