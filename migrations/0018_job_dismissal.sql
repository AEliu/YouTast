-- Preserve the unique conversion job so routine scans cannot recreate a task
-- the user deliberately cleared. Explicit episode regeneration clears this flag.
ALTER TABLE jobs ADD COLUMN dismissed_at INTEGER;
