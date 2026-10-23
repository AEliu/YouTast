-- Playlist inventory is separate from collected episodes. The first complete
-- snapshot establishes a baseline without downloading the entire history.
ALTER TABLE sources ADD COLUMN discovery_initialized INTEGER NOT NULL DEFAULT 0;
ALTER TABLE executors ADD COLUMN discovery_control_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN discovery_lease TEXT;
ALTER TABLE jobs ADD COLUMN discovery_selection TEXT;
ALTER TABLE jobs ADD COLUMN discovery_more INTEGER NOT NULL DEFAULT 0;
CREATE TABLE source_discoveries(
 source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 video_id TEXT NOT NULL,
 pending INTEGER NOT NULL CHECK(pending IN(0,1)),
 PRIMARY KEY(source_id,video_id)
);
