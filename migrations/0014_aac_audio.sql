ALTER TABLE executors ADD COLUMN audio_control_version INTEGER NOT NULL DEFAULT 0;
DROP VIEW channel_preferences;
CREATE VIEW channel_preferences AS SELECT c.*,
 COALESCE(json_extract(c.settings,'$.retention_days'),json_extract(u.settings,'$.retention_days'),0) AS retention_days,
 COALESCE(json_extract(c.settings,'$.bitrate'),json_extract(u.settings,'$.bitrate'),64) AS bitrate,
 COALESCE(json_extract(c.settings,'$.audio_mode'),json_extract(u.settings,'$.audio_mode'),'source') AS audio_mode,
 CASE WHEN COALESCE(json_extract(c.settings,'$.audio_mode'),json_extract(u.settings,'$.audio_mode'),'source')='mp3' THEN 'mp3:'||COALESCE(json_extract(c.settings,'$.bitrate'),json_extract(u.settings,'$.bitrate'),64)||':original' ELSE 'm4a:'||COALESCE(json_extract(c.settings,'$.bitrate'),json_extract(u.settings,'$.bitrate'),64)||':'||COALESCE(json_extract(c.settings,'$.audio_mode'),json_extract(u.settings,'$.audio_mode'),'source') END AS audio_profile,
 COALESCE(json_extract(c.settings,'$.text_language'),json_extract(u.settings,'$.text_language'),'zh-CN') AS text_language,
 COALESCE(json_extract(c.settings,'$.scan_limit'),json_extract(u.settings,'$.scan_limit'),30) AS scan_limit,
 COALESCE(json_extract(c.settings,'$.latest_limit'),json_extract(u.settings,'$.latest_limit'),0) AS latest_limit,
 COALESCE(json_extract(c.settings,'$.sync_hours'),json_extract(u.settings,'$.sync_hours'),6) AS sync_hours,
 COALESCE(json_extract(c.settings,'$.feed_limit'),json_extract(u.settings,'$.feed_limit'),500) AS feed_limit,
 COALESCE(json_extract(c.settings,'$.sort_mode'),json_extract(u.settings,'$.sort_mode'),'source') AS effective_sort_mode,
 COALESCE(json_extract(c.rss_metadata,'$.language'),NULLIF(json_extract(c.settings,'$.text_language'),'original'),NULLIF(json_extract(u.settings,'$.text_language'),'original'),'zh-CN') AS rss_language
 FROM channels c JOIN users u ON u.id=c.user_id;
