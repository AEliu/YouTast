import {id} from './lib.js';
import {cleanMetadata} from './preferences.js';

// One D1 statement for the whole scan, including 100-entry scans on Workers Free.
export function scanRecords(env,job,lease,entries,t) {
 const records=entries.map(e=>({record_id:id(),video_id:e.video_id,title:e.title,duration:e.duration,published_at:e.published_at??null,position:e.position,metadata:cleanMetadata(e.metadata||{})}));
 return env.DB.prepare(`INSERT INTO episodes(id,channel_id,video_id,title,duration,created_at,published_at,source_order,source_kind,source_position,added_position,metadata)
 SELECT json_extract(batch.value,'$.record_id'),s.channel_id,json_extract(batch.value,'$.video_id'),json_extract(batch.value,'$.title'),
  json_extract(batch.value,'$.duration'),s.created_at,json_extract(batch.value,'$.published_at'),s.sort_order,s.kind,
  json_extract(batch.value,'$.position'),json_extract(batch.value,'$.position'),json_extract(batch.value,'$.metadata')
 FROM json_each(?) batch JOIN sources s ON s.id=?
 WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?)
 ON CONFLICT(channel_id,video_id) DO UPDATE SET
  title=excluded.title,duration=CASE WHEN episodes.object_key IS NULL THEN excluded.duration ELSE episodes.duration END,
  published_at=COALESCE(episodes.published_at,excluded.published_at),
  metadata=CASE WHEN COALESCE(json_extract(episodes.metadata,'$.text_language'),'zh-CN')!=COALESCE(json_extract(excluded.metadata,'$.text_language'),'zh-CN') THEN excluded.metadata ELSE json_object(
   'description',COALESCE(NULLIF(json_extract(episodes.metadata,'$.description'),''),json_extract(excluded.metadata,'$.description')),
   'author',COALESCE(NULLIF(json_extract(episodes.metadata,'$.author'),''),json_extract(excluded.metadata,'$.author')),
   'thumbnail',COALESCE(NULLIF(json_extract(episodes.metadata,'$.thumbnail'),''),json_extract(excluded.metadata,'$.thumbnail')),
   'language',COALESCE(NULLIF(json_extract(episodes.metadata,'$.language'),''),json_extract(excluded.metadata,'$.language')),
   'text_language',COALESCE(json_extract(excluded.metadata,'$.text_language'),json_extract(episodes.metadata,'$.text_language'),'zh-CN'),
   'complete',json(CASE WHEN json_extract(episodes.metadata,'$.complete')=1 OR json_extract(excluded.metadata,'$.complete')=1 THEN 'true' ELSE 'false' END),
   'chapters',json(CASE WHEN json_array_length(episodes.metadata,'$.chapters')>0 THEN json_extract(episodes.metadata,'$.chapters') ELSE json_extract(excluded.metadata,'$.chapters') END)) END,
  created_at=MIN(episodes.created_at,excluded.created_at),
  source_order=CASE WHEN episodes.source_order=0 OR excluded.source_order<=episodes.source_order THEN excluded.source_order ELSE episodes.source_order END,
  source_kind=CASE WHEN episodes.source_order=0 OR excluded.source_order<=episodes.source_order THEN excluded.source_kind ELSE episodes.source_kind END,
  added_position=CASE WHEN episodes.source_order=0 OR excluded.source_order<episodes.source_order THEN excluded.added_position ELSE episodes.added_position END,
  source_position=CASE WHEN episodes.source_order=0 OR excluded.source_order<=episodes.source_order THEN excluded.source_position ELSE episodes.source_position END`)
  .bind(JSON.stringify(records),job.source_id,job.id,lease,t);
}
