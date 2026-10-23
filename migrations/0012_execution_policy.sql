CREATE TABLE execution_policy(
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 concurrency INTEGER NOT NULL DEFAULT 1 CHECK(concurrency BETWEEN 1 AND 3),
 start_interval INTEGER NOT NULL DEFAULT 60 CHECK(start_interval BETWEEN 0 AND 3600),
 request_interval INTEGER NOT NULL DEFAULT 2 CHECK(request_interval BETWEEN 0 AND 30),
 download_wait INTEGER NOT NULL DEFAULT 10 CHECK(download_wait BETWEEN 0 AND 60),
 cooldown_seconds INTEGER NOT NULL DEFAULT 1800 CHECK(cooldown_seconds BETWEEN 60 AND 86400),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
 next_start_at INTEGER NOT NULL DEFAULT 0,
 cooldown_until INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE executors ADD COLUMN rate_control_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER throttle_job_start BEFORE UPDATE OF status ON jobs
WHEN NEW.status='running' AND OLD.status!='running'
BEGIN
 INSERT OR IGNORE INTO execution_policy(user_id) VALUES(NEW.user_id);
 SELECT CASE WHEN EXISTS(SELECT 1 FROM execution_policy p WHERE p.user_id=NEW.user_id
  AND (p.paused=1 OR p.next_start_at>unixepoch() OR p.cooldown_until>unixepoch()
   OR (SELECT COUNT(*) FROM jobs WHERE user_id=NEW.user_id AND status='running' AND lease_until>unixepoch())>=p.concurrency))
  THEN RAISE(ABORT,'execution_throttled') END;
 UPDATE execution_policy SET next_start_at=unixepoch()+start_interval WHERE user_id=NEW.user_id;
END;
