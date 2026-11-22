-- v1.9.3
-- Manual lead outcome: the owner marks a conversation "Successful" (a deal or result was won). Independent from the reply
-- tag (Interested / More info / Not interested / Neutral), so a thread can be tagged Interested and later marked Successful.
-- NULL = not marked. outcome_at = when it was marked.
ALTER TABLE campaign_leads ADD COLUMN outcome TEXT CHECK (outcome IS NULL OR outcome = 'successful');
ALTER TABLE campaign_leads ADD COLUMN outcome_at INTEGER;
