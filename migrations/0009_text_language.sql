-- Language controls YouTube text metadata, never audio track selection.
UPDATE users SET settings=json_remove(settings,'$.preferred_language','$.rss_language');
UPDATE channels SET settings=json_remove(settings,'$.preferred_language');
DROP VIEW channel_preferences;
CREATE VIEW channel_preferences AS SELECT c.*,
 COALESCE(json_extract(c.settings,'$.retention_days'),json_extract(u.settings,'$.retention_days'),0) AS retention_days,
 COALESCE(json_extract(c.settings,'$.bitrate'),json_extract(u.settings,'$.bitrate'),64) AS bitrate,
 COALESCE(json_extract(c.settings,'$.text_language'),json_extract(u.settings,'$.text_language'),'zh-CN') AS text_language,
 COALESCE(json_extract(c.settings,'$.scan_limit'),json_extract(u.settings,'$.scan_limit'),30) AS scan_limit,
 COALESCE(json_extract(c.settings,'$.sync_hours'),json_extract(u.settings,'$.sync_hours'),6) AS sync_hours,
 COALESCE(json_extract(c.settings,'$.feed_limit'),json_extract(u.settings,'$.feed_limit'),500) AS feed_limit,
 COALESCE(json_extract(c.settings,'$.sort_mode'),json_extract(u.settings,'$.sort_mode'),'source') AS effective_sort_mode,
 COALESCE(json_extract(c.rss_metadata,'$.language'),NULLIF(json_extract(c.settings,'$.text_language'),'original'),NULLIF(json_extract(u.settings,'$.text_language'),'original'),'zh-CN') AS rss_language
 FROM channels c JOIN users u ON u.id=c.user_id;
