ALTER TABLE users ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
ALTER TABLE channels ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';
ALTER TABLE channels ADD COLUMN rss_metadata TEXT NOT NULL DEFAULT '{}';
UPDATE channels SET settings=json_object('sort_mode',sort_mode);
ALTER TABLE episodes ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
ALTER TABLE episodes ADD COLUMN encoding_profile TEXT NOT NULL DEFAULT 'mp3:64:original';
ALTER TABLE episodes ADD COLUMN ready_at INTEGER;
ALTER TABLE episodes ADD COLUMN expired_at INTEGER;
UPDATE episodes SET ready_at=COALESCE((SELECT MAX(updated_at) FROM jobs WHERE episode_id=episodes.id AND status='done'),created_at) WHERE object_key IS NOT NULL;
ALTER TABLE jobs ADD COLUMN encoding_profile TEXT NOT NULL DEFAULT 'mp3:64:original';
CREATE VIEW channel_preferences AS SELECT c.*,
 COALESCE(json_extract(c.settings,'$.retention_days'),json_extract(u.settings,'$.retention_days'),0) AS retention_days,
 COALESCE(json_extract(c.settings,'$.bitrate'),json_extract(u.settings,'$.bitrate'),64) AS bitrate,
 COALESCE(json_extract(c.settings,'$.preferred_language'),json_extract(u.settings,'$.preferred_language'),'original') AS preferred_language,
 COALESCE(json_extract(c.settings,'$.scan_limit'),json_extract(u.settings,'$.scan_limit'),30) AS scan_limit,
 COALESCE(json_extract(c.settings,'$.sync_hours'),json_extract(u.settings,'$.sync_hours'),6) AS sync_hours,
 COALESCE(json_extract(c.settings,'$.feed_limit'),json_extract(u.settings,'$.feed_limit'),500) AS feed_limit,
 COALESCE(json_extract(c.settings,'$.sort_mode'),json_extract(u.settings,'$.sort_mode'),'source') AS effective_sort_mode,
 COALESCE(json_extract(c.rss_metadata,'$.language'),json_extract(u.settings,'$.rss_language'),'zh-CN') AS rss_language
 FROM channels c JOIN users u ON u.id=c.user_id;
CREATE INDEX episodes_retention ON episodes(channel_id,ready_at) WHERE object_key IS NOT NULL;
