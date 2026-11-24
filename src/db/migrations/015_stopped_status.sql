-- sb:fk-off
-- v1.9.14: campaign_leads gets a 'stopped' status (a person stopped in ONE campaign: manually, by a "not interested" reply or by
-- the "stop campaign" phrase). SQLite cannot change a CHECK constraint in place, so the table is rebuilt with the same columns,
-- keys and indexes. The runner switches foreign keys off around this file (the first line above), otherwise DROP TABLE would
-- apply ON DELETE SET NULL to every message; it re-checks all foreign keys afterwards and turns them back on.
CREATE TABLE campaign_leads_new (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  sender_id    INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  position     INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','active','replied','completed','bounced','unsubscribed','paused','error','stopped')),
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at INTEGER,
  last_sent_at INTEGER,
  status_note  TEXT,
  removed_at   INTEGER,
  outcome      TEXT CHECK (outcome IS NULL OR outcome = 'successful'),
  outcome_at   INTEGER,
  UNIQUE (campaign_id, lead_id)
);
INSERT INTO campaign_leads_new (id, campaign_id, lead_id, sender_id, position, status, current_step, next_send_at, last_sent_at, status_note, removed_at, outcome, outcome_at)
  SELECT id, campaign_id, lead_id, sender_id, position, status, current_step, next_send_at, last_sent_at, status_note, removed_at, outcome, outcome_at FROM campaign_leads;
-- keep the AUTOINCREMENT counter so an old id is never handed out again
UPDATE sqlite_sequence SET seq = (SELECT seq FROM sqlite_sequence WHERE name = 'campaign_leads') WHERE name = 'campaign_leads_new' AND EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'campaign_leads');
DROP TABLE campaign_leads;
ALTER TABLE campaign_leads_new RENAME TO campaign_leads;
CREATE INDEX idx_cl_due ON campaign_leads(next_send_at) WHERE status = 'active';
CREATE INDEX idx_cl_sender_due ON campaign_leads(sender_id, next_send_at) WHERE status = 'active';
-- people stopped by hand in v1.9.12/13 were stored as 'completed' with a note: they are 'stopped' now
UPDATE campaign_leads SET status = 'stopped' WHERE status = 'completed' AND status_note = 'Stopped manually';
