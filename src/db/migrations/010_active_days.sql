-- Which weekdays a campaign may send on, as a bit mask (Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64).
-- NULL keeps the old behaviour: weekdays_only = 1 means Mon-Fri, 0 means every day.
ALTER TABLE campaigns ADD COLUMN active_days INTEGER CHECK (active_days IS NULL OR active_days BETWEEN 1 AND 127);
