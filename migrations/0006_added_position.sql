-- Preserve first-added order separately from a playlist's mutable current position.
ALTER TABLE episodes ADD COLUMN added_position INTEGER NOT NULL DEFAULT 0;
UPDATE episodes SET added_position=source_position;
