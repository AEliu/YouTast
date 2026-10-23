ALTER TABLE sources ADD COLUMN waiting_replay INTEGER NOT NULL DEFAULT 0 CHECK(waiting_replay IN(0,1));
ALTER TABLE executors ADD COLUMN replay_control_version INTEGER NOT NULL DEFAULT 0;
-- Recover single streams skipped by old clients, which parked empty scans for
-- ten years. Sources with an existing episode (including deleted audio) stay put.
UPDATE sources SET waiting_replay=1,next_scan=unixepoch()
WHERE kind='video' AND next_scan>unixepoch()+86400
AND NOT EXISTS(SELECT 1 FROM episodes e WHERE e.channel_id=sources.channel_id AND e.video_id=substr(sources.url,-11));
