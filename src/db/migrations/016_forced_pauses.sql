-- Sending accounts: a lifetime counter of automatic health pauses ("Forced pauses", shown in Settings -> Sending accounts) and a flag that
-- remembers a pause was made by the health protection (so it can be lifted automatically once the account has really recovered, and
-- never lifts a pause the owner made by hand). Additive only: existing rows start at 0 and nothing is rewritten.
ALTER TABLE senders ADD COLUMN forced_pauses INTEGER NOT NULL DEFAULT 0;
ALTER TABLE senders ADD COLUMN health_paused INTEGER NOT NULL DEFAULT 0 CHECK (health_paused IN (0,1));
