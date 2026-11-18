-- v1.8.0
-- Sender controls: per-sender reply detection switch, protection level (how strict automatic health pauses are)
-- and a time-limited "force continue" override that bypasses automatic health / failure-streak pauses.
ALTER TABLE senders ADD COLUMN reply_detection INTEGER NOT NULL DEFAULT 1 CHECK (reply_detection IN (0,1));
ALTER TABLE senders ADD COLUMN protection_level TEXT NOT NULL DEFAULT 'medium' CHECK (protection_level IN ('low','medium','high'));
ALTER TABLE senders ADD COLUMN force_until INTEGER;

-- Campaign scheduling: an optional future start (UTC ms; NULL = start immediately) and how the engine orders
-- work when a sender is busy: follow-ups before new first emails, the other way round, or by oldest due first.
ALTER TABLE campaigns ADD COLUMN start_at INTEGER;
ALTER TABLE campaigns ADD COLUMN priority_mode TEXT NOT NULL DEFAULT 'followups_first' CHECK (priority_mode IN ('followups_first','balanced','new_first'));

-- A person removed from a running campaign after bouncing, unsubscribing or finishing is hidden from the People list but
-- the row (status, messages, stats) stays, so campaign history and analytics are never rewritten.
ALTER TABLE campaign_leads ADD COLUMN removed_at INTEGER;

-- Home 'Campaign health' card: which alerts the user has already looked at (JSON array of alert keys, stored server-side because the UI keeps nothing in the browser).
ALTER TABLE user_settings ADD COLUMN health_seen TEXT;
