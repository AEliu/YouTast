-- Keep durable upload intents until metadata commits. This also accounts for
-- objects left behind when a Worker or executor loses its lease mid-upload.
CREATE TABLE object_gc (
 object_key TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 size INTEGER NOT NULL CHECK(size >= 0),
 not_before INTEGER NOT NULL,
 job_id TEXT,
 lease_token TEXT,
 created_at INTEGER NOT NULL
);
CREATE INDEX object_gc_due ON object_gc(not_before);
CREATE INDEX object_gc_owner ON object_gc(user_id);
CREATE INDEX login_limits_expiry ON login_limits(reset_at);

-- No foreign key: cleanup records must survive deletion of their owner/channel.
CREATE TRIGGER episodes_delete_audio BEFORE DELETE ON episodes
WHEN OLD.object_key IS NOT NULL
BEGIN
 INSERT OR IGNORE INTO object_gc(object_key,user_id,size,not_before,created_at)
 VALUES(OLD.object_key,substr(OLD.object_key,1,instr(OLD.object_key,'/')-1),OLD.size,unixepoch(),unixepoch());
END;

CREATE TRIGGER episodes_replace_audio BEFORE UPDATE OF object_key ON episodes
WHEN OLD.object_key IS NOT NULL AND OLD.object_key IS NOT NEW.object_key
BEGIN
 INSERT OR IGNORE INTO object_gc(object_key,user_id,size,not_before,created_at)
 VALUES(OLD.object_key,substr(OLD.object_key,1,instr(OLD.object_key,'/')-1),OLD.size,unixepoch(),unixepoch());
END;
