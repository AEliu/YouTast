// Scope before ranking: filtering the global window view afterwards makes SQLite
// rank unrelated users' episodes. Callers supply only constant SQL and bind scope.
export function windowCte(scope) {
 return `WITH window_channels AS MATERIALIZED (
  SELECT id,latest_limit FROM channel_preferences WHERE ${scope}
 ), window_episodes AS MATERIALIZED (
  SELECT e.id,e.channel_id,e.published_at,e.created_at FROM episodes e
  JOIN window_channels c ON c.id=e.channel_id
 ), source_ranked AS MATERIALIZED (
  SELECT es.episode_id,s.latest_limit,ROW_NUMBER() OVER(PARTITION BY s.id
   ORDER BY e.published_at IS NULL,e.published_at DESC,es.discovered_at DESC,
   CASE WHEN s.kind='author' THEN es.position ELSE -es.position END,e.id) source_rank
  FROM window_episodes e JOIN episode_sources es ON es.episode_id=e.id
  JOIN sources s ON s.id=es.source_id WHERE s.latest_limit>0
 ), window_eligible AS MATERIALIZED (
  SELECT e.* FROM window_episodes e WHERE
   NOT EXISTS(SELECT 1 FROM episode_sources es WHERE es.episode_id=e.id)
   OR EXISTS(SELECT 1 FROM episode_sources es JOIN sources s ON s.id=es.source_id
    WHERE es.episode_id=e.id AND s.latest_limit=0)
   OR EXISTS(SELECT 1 FROM source_ranked r WHERE r.episode_id=e.id AND r.source_rank<=r.latest_limit)
 ), channel_ranked AS (
  SELECT e.id,e.channel_id,c.latest_limit,ROW_NUMBER() OVER(PARTITION BY e.channel_id
   ORDER BY e.published_at IS NULL,e.published_at DESC,e.created_at DESC,e.id) recent_rank
  FROM window_eligible e JOIN window_channels c ON c.id=e.channel_id WHERE c.latest_limit>0
 ), scoped_window AS MATERIALIZED (
  SELECT e.id,e.channel_id FROM window_eligible e JOIN window_channels c ON c.id=e.channel_id WHERE c.latest_limit=0
  UNION ALL SELECT id,channel_id FROM channel_ranked WHERE recent_rank<=latest_limit
 )`;
}
