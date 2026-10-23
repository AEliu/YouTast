ALTER TABLE jobs ADD COLUMN reused INTEGER NOT NULL DEFAULT 0 CHECK(reused IN (0,1));
CREATE INDEX episodes_video ON episodes(video_id);

-- Cached audio may be referenced by multiple channels belonging to one user.
-- Only enqueue physical deletion when the last reference disappears.
DROP TRIGGER episodes_delete_audio;
DROP TRIGGER episodes_replace_audio;
CREATE TRIGGER episodes_delete_audio BEFORE DELETE ON episodes
WHEN OLD.object_key IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM episodes WHERE object_key=OLD.object_key AND id!=OLD.id)
BEGIN
 INSERT OR IGNORE INTO object_gc(object_key,user_id,size,not_before,created_at)
 VALUES(OLD.object_key,substr(OLD.object_key,1,instr(OLD.object_key,'/')-1),OLD.size,unixepoch(),unixepoch());
END;
CREATE TRIGGER episodes_replace_audio BEFORE UPDATE OF object_key ON episodes
WHEN OLD.object_key IS NOT NULL AND OLD.object_key IS NOT NEW.object_key
 AND NOT EXISTS(SELECT 1 FROM episodes WHERE object_key=OLD.object_key AND id!=OLD.id)
BEGIN
 INSERT OR IGNORE INTO object_gc(object_key,user_id,size,not_before,created_at)
 VALUES(OLD.object_key,substr(OLD.object_key,1,instr(OLD.object_key,'/')-1),OLD.size,unixepoch(),unixepoch());
END;

CREATE TRIGGER sources_limit BEFORE INSERT ON sources
WHEN (SELECT COUNT(*) FROM sources WHERE channel_id=NEW.channel_id)>=30
 AND NOT EXISTS(SELECT 1 FROM sources WHERE channel_id=NEW.channel_id AND url=NEW.url)
BEGIN
 SELECT RAISE(ABORT,'source_limit');
END;
