-- Sending engine + reply tracking support.

-- Sender runtime state
ALTER TABLE senders ADD COLUMN next_send_at INTEGER;                       -- earliest time this sender may send again (throttle / backoff)
ALTER TABLE senders ADD COLUMN last_error TEXT;                            -- why the engine paused or slowed this sender
ALTER TABLE senders ADD COLUMN error_streak INTEGER NOT NULL DEFAULT 0;    -- consecutive transient failures
ALTER TABLE senders ADD COLUMN imap_uidvalidity INTEGER;
ALTER TABLE senders ADD COLUMN imap_last_uid INTEGER;                      -- NULL = reply tracking not armed yet
ALTER TABLE senders ADD COLUMN last_sync_at INTEGER;                       -- last SUCCESSFUL inbox sync
ALTER TABLE senders ADD COLUMN sync_error TEXT;

-- Messages: classification and bookkeeping
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'email' CHECK (kind IN ('email','bounce','auto_reply'));
ALTER TABLE messages ADD COLUMN step_no INTEGER;                           -- sequence step for campaign emails; NULL for manual replies
ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN error_class TEXT;                          -- recipient | policy | transient | auth | quota | interrupted | hard | soft
ALTER TABLE messages ADD COLUMN read_at INTEGER;
ALTER TABLE messages ADD COLUMN from_addr TEXT;
ALTER TABLE messages ADD COLUMN to_addr TEXT;
ALTER TABLE messages ADD COLUMN sentiment_manual INTEGER NOT NULL DEFAULT 0 CHECK (sentiment_manual IN (0,1));

-- Why a lead was stopped (shown in the campaign lead list)
ALTER TABLE campaign_leads ADD COLUMN status_note TEXT;

CREATE INDEX idx_messages_sender_time ON messages(sender_id, direction, status, sent_at);
CREATE INDEX idx_messages_thread ON messages(campaign_lead_id, created_at);
CREATE INDEX idx_cl_sender_due ON campaign_leads(sender_id, next_send_at) WHERE status = 'active';
