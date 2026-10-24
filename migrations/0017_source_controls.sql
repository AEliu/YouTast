ALTER TABLE sources ADD COLUMN latest_limit INTEGER NOT NULL DEFAULT 0 CHECK(latest_limit BETWEEN 0 AND 100);
ALTER TABLE sources ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1));
CREATE TABLE episode_sources(
 source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
 episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
 discovered_at INTEGER NOT NULL,
 position INTEGER NOT NULL,
 PRIMARY KEY(source_id,episode_id)
);
CREATE INDEX episode_sources_episode ON episode_sources(episode_id);
-- Recover known provenance. Future scans add overlaps without changing the
-- episode's original ordering source or duplicating its audio.
INSERT OR IGNORE INTO episode_sources
 SELECT s.id,e.id,COALESCE(e.ready_at,e.created_at),e.source_position FROM episodes e
 JOIN sources s ON s.channel_id=e.channel_id AND s.sort_order=e.source_order;
INSERT OR IGNORE INTO episode_sources
 SELECT s.id,e.id,COALESCE(e.ready_at,e.created_at),e.source_position FROM source_discoveries d
 JOIN sources s ON s.id=d.source_id JOIN episodes e ON e.channel_id=s.channel_id AND e.video_id=d.video_id;
DROP VIEW active_episode_window;
CREATE VIEW active_episode_window AS
 WITH source_ranked AS (
  SELECT es.episode_id,s.latest_limit,
   ROW_NUMBER() OVER(PARTITION BY s.id ORDER BY e.published_at IS NULL,e.published_at DESC,
    es.discovered_at DESC,CASE WHEN s.kind='author' THEN es.position ELSE -es.position END,e.id) source_rank
  FROM episode_sources es JOIN sources s ON s.id=es.source_id JOIN episodes e ON e.id=es.episode_id
 ), eligible AS (
  SELECT e.* FROM episodes e WHERE NOT EXISTS(SELECT 1 FROM episode_sources es WHERE es.episode_id=e.id)
   OR EXISTS(SELECT 1 FROM source_ranked r WHERE r.episode_id=e.id AND (r.latest_limit=0 OR r.source_rank<=r.latest_limit))
 ), channel_ranked AS (
  SELECT e.id,e.channel_id,p.latest_limit,ROW_NUMBER() OVER(PARTITION BY e.channel_id
   ORDER BY e.published_at IS NULL,e.published_at DESC,e.created_at DESC,e.id) recent_rank
  FROM eligible e JOIN channel_preferences p ON p.id=e.channel_id
 ) SELECT id,channel_id FROM channel_ranked WHERE latest_limit=0 OR recent_rank<=latest_limit;
