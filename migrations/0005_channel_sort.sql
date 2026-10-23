ALTER TABLE channels ADD COLUMN sort_mode TEXT NOT NULL DEFAULT 'source' CHECK(sort_mode IN ('source','published_asc','published_desc','added_asc','added_desc'));
ALTER TABLE sources ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE sources SET sort_order=(SELECT COUNT(*) FROM sources older WHERE older.channel_id=sources.channel_id AND older.rowid<=sources.rowid);
ALTER TABLE episodes ADD COLUMN published_at INTEGER;
-- Snapshot provenance survives removal of a source; smaller source order wins overlaps.
ALTER TABLE episodes ADD COLUMN source_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE episodes ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE episodes ADD COLUMN source_position INTEGER NOT NULL DEFAULT 0;
UPDATE episodes SET source_order=COALESCE((SELECT sort_order FROM sources WHERE channel_id=episodes.channel_id AND url='https://www.youtube.com/watch?v='||episodes.video_id),0),
 source_kind=CASE WHEN EXISTS(SELECT 1 FROM sources WHERE channel_id=episodes.channel_id AND url='https://www.youtube.com/watch?v='||episodes.video_id) THEN 'video' ELSE 'legacy' END;
CREATE INDEX episodes_source_order ON episodes(channel_id,source_order,source_position);
