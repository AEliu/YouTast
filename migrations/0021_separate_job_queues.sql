ALTER TABLE execution_policy ADD COLUMN scan_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(scan_concurrency BETWEEN 1 AND 3);
ALTER TABLE execution_policy ADD COLUMN scan_start_interval INTEGER NOT NULL DEFAULT 15 CHECK(scan_start_interval BETWEEN 0 AND 3600);
ALTER TABLE execution_policy ADD COLUMN scan_next_start_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX jobs_queue_claim ON jobs(user_id,kind,status,available_at);

DROP TRIGGER throttle_job_start;
CREATE TRIGGER throttle_job_start BEFORE UPDATE OF status ON jobs
WHEN NEW.status='running' AND OLD.status!='running'
BEGIN
 INSERT OR IGNORE INTO execution_policy(user_id) VALUES(NEW.user_id);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM execution_policy p WHERE p.user_id=NEW.user_id AND (
  p.paused=1 OR p.cooldown_until>unixepoch()
  OR (CASE WHEN NEW.kind='scan' THEN p.scan_next_start_at ELSE p.next_start_at END)>unixepoch()
  OR (SELECT COUNT(*) FROM jobs WHERE user_id=NEW.user_id AND kind=NEW.kind AND status='running' AND lease_until>unixepoch())
     >=CASE WHEN NEW.kind='scan' THEN p.scan_concurrency ELSE p.concurrency END
 )) THEN RAISE(ABORT,'execution_throttled') END;
 UPDATE execution_policy SET
  next_start_at=CASE WHEN NEW.kind='transcode' THEN unixepoch()+start_interval ELSE next_start_at END,
  scan_next_start_at=CASE WHEN NEW.kind='scan' THEN unixepoch()+scan_start_interval ELSE scan_next_start_at END
 WHERE user_id=NEW.user_id;
END;
