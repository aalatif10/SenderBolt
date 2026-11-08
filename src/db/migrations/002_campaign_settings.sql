-- Campaign sending preferences. Hours are in the campaign's local time (utc_offset_min from UTC).
ALTER TABLE campaigns ADD COLUMN window_start_hour INTEGER NOT NULL DEFAULT 9  CHECK (window_start_hour BETWEEN 0 AND 23);
ALTER TABLE campaigns ADD COLUMN window_end_hour   INTEGER NOT NULL DEFAULT 17 CHECK (window_end_hour BETWEEN 1 AND 24);
ALTER TABLE campaigns ADD COLUMN utc_offset_min    INTEGER NOT NULL DEFAULT 0  CHECK (utc_offset_min BETWEEN -720 AND 840);
ALTER TABLE campaigns ADD COLUMN weekdays_only     INTEGER NOT NULL DEFAULT 1  CHECK (weekdays_only IN (0,1));
ALTER TABLE campaigns ADD COLUMN stop_on_reply     INTEGER NOT NULL DEFAULT 1  CHECK (stop_on_reply IN (0,1));
ALTER TABLE campaigns ADD COLUMN track_opens       INTEGER NOT NULL DEFAULT 0  CHECK (track_opens IN (0,1));
