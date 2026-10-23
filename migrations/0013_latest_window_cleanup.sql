ALTER TABLE episodes ADD COLUMN cleanup_reason TEXT;
UPDATE episodes SET cleanup_reason='retention' WHERE expired_at IS NOT NULL;
ALTER TABLE executors ADD COLUMN window_control_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX episodes_recent ON episodes(channel_id,published_at IS NULL,published_at DESC,created_at DESC,id);
CREATE TABLE storage_cleanup_locks(lock_key TEXT PRIMARY KEY,token TEXT NOT NULL,lease_until INTEGER NOT NULL);
DROP VIEW channel_preferences;
CREATE VIEW channel_preferences AS SELECT c.*,
 COALESCE(json_extract(c.settings,'$.retention_days'),json_extract(u.settings,'$.retention_days'),0) AS retention_days,
 COALESCE(json_extract(c.settings,'$.bitrate'),json_extract(u.settings,'$.bitrate'),64) AS bitrate,
 COALESCE(json_extract(c.settings,'$.text_language'),json_extract(u.settings,'$.text_language'),'zh-CN') AS text_language,
 COALESCE(json_extract(c.settings,'$.scan_limit'),json_extract(u.settings,'$.scan_limit'),30) AS scan_limit,
 COALESCE(json_extract(c.settings,'$.latest_limit'),json_extract(u.settings,'$.latest_limit'),0) AS latest_limit,
 COALESCE(json_extract(c.settings,'$.sync_hours'),json_extract(u.settings,'$.sync_hours'),6) AS sync_hours,
 COALESCE(json_extract(c.settings,'$.feed_limit'),json_extract(u.settings,'$.feed_limit'),500) AS feed_limit,
 COALESCE(json_extract(c.settings,'$.sort_mode'),json_extract(u.settings,'$.sort_mode'),'source') AS effective_sort_mode,
 COALESCE(json_extract(c.rss_metadata,'$.language'),NULLIF(json_extract(c.settings,'$.text_language'),'original'),NULLIF(json_extract(u.settings,'$.text_language'),'original'),'zh-CN') AS rss_language
 FROM channels c JOIN users u ON u.id=c.user_id;
CREATE VIEW active_episode_window AS
 SELECT e.id,e.channel_id FROM episodes e JOIN channel_preferences p ON p.id=e.channel_id WHERE p.latest_limit=0
 UNION ALL
 SELECT id,channel_id FROM (
  SELECT e.id,e.channel_id,p.latest_limit,ROW_NUMBER() OVER(PARTITION BY e.channel_id ORDER BY e.published_at IS NULL,e.published_at DESC,e.created_at DESC,e.id) AS recent_rank
  FROM episodes e JOIN channel_preferences p ON p.id=e.channel_id WHERE p.latest_limit>0
 ) WHERE recent_rank<=latest_limit;
