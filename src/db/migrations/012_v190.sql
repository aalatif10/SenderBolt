-- v1.9.0
-- Health healing: positive signals (calm days, clean sends, replies) earn "heal" points that raise the health score
-- gradually (cap 100). health_base is the score the last 30 days of results alone would give; the stored health_score
-- is min(100, health_base + health_heal). health_heal_day is the last UTC day already credited; health_severe_n is the
-- number of severe events (hard/policy bounces, refused recipients) seen at the last recompute: a new one resets the heal.
ALTER TABLE senders ADD COLUMN health_heal INTEGER NOT NULL DEFAULT 0;
ALTER TABLE senders ADD COLUMN health_heal_day TEXT;
ALTER TABLE senders ADD COLUMN health_severe_n INTEGER NOT NULL DEFAULT 0;
ALTER TABLE senders ADD COLUMN health_base INTEGER;

-- Connection problems (wrong/revoked App Password, network down, provider unreachable) are shown on the sender and retried
-- with a back-off. They never pause the sender or hurt its health. Cleared by the next successful send or connection test.
ALTER TABLE senders ADD COLUMN connection_error TEXT;
ALTER TABLE senders ADD COLUMN connection_error_at INTEGER;

-- A failed mailbox read caused by a time-out / network blip is transient: it must not block sending (the 15-minute
-- freshness rule still protects reply tracking). sync_failures drives the retry back-off.
ALTER TABLE senders ADD COLUMN sync_transient INTEGER NOT NULL DEFAULT 0;
ALTER TABLE senders ADD COLUMN sync_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE senders ADD COLUMN sync_retry_at INTEGER;

-- Campaigns can be archived from the Campaigns table (hidden from the default view, results kept). Only main campaigns use it.
ALTER TABLE campaigns ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1));
