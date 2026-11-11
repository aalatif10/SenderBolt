-- Warm-up v2: the ramp follows the days a sender REALLY sent mail (not the calendar), can be paced
-- gently, and is slowed automatically when recent bounces climb. The on/off switch (warmup_enabled)
-- already exists; when it is off the sender uses its full daily limit from day one.

-- Completed ramp days: UTC days on which the sender sent at least half of that day's ramp allowance.
-- (The day in progress is not counted until the sender sends again on a later day; see lib/throttle.js rampIndex.)
ALTER TABLE senders ADD COLUMN warmup_days INTEGER NOT NULL DEFAULT 0;
-- Steps to step back on the ramp because of recent bounces (recomputed with the health score; 0 = none).
ALTER TABLE senders ADD COLUMN warmup_penalty INTEGER NOT NULL DEFAULT 0;
-- Ramp speed: 'standard' (about 3 weeks to 400/day) or 'gentle' (about 5 weeks).
ALTER TABLE senders ADD COLUMN warmup_pace TEXT NOT NULL DEFAULT 'standard' CHECK (warmup_pace IN ('standard','gentle'));

-- Senders that already ramped under the old calendar-based rule keep their progress (minus one day, to stay on the safe side).
UPDATE senders SET warmup_days = MAX(0, CAST((CAST(strftime('%s','now') AS INTEGER) * 1000 - warmup_started_at) / 86400000 AS INTEGER) - 1)
  WHERE warmup_started_at IS NOT NULL;
