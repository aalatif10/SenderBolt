-- Campaign health: alerts the owner dismissed with the small "x". Same shape as health_seen (JSON list of alert keys);
-- keys of alerts that are gone are dropped by the client on the next save, so a problem that returns shows again.
ALTER TABLE user_settings ADD COLUMN health_dismissed TEXT;
