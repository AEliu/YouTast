import {requireValue} from './lib.js';

export function validateSourceControls(value){
 requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length>0&&Object.keys(value).every(k=>['latest_limit','paused'].includes(k)),400,'来源设置无效');
 if(Object.hasOwn(value,'latest_limit'))requireValue(Number.isInteger(value.latest_limit)&&value.latest_limit>=0&&value.latest_limit<=100,400,'来源最新数量需为0–100的整数');
 if(Object.hasOwn(value,'paused'))requireValue(typeof value.paused==='boolean',400,'来源暂停状态无效');
 return value;
}

export function backfillSourceMembership(env,sourceId){
 // Also covers rows written by an older Worker between migration and deploy.
 return env.DB.prepare(`INSERT OR IGNORE INTO episode_sources(source_id,episode_id,discovered_at,position)
  SELECT s.id,e.id,COALESCE(e.ready_at,e.created_at),e.source_position FROM sources s JOIN episodes e ON e.channel_id=s.channel_id
  WHERE s.id=? AND (e.source_order=s.sort_order OR (s.kind='video' AND s.url='https://www.youtube.com/watch?v='||e.video_id)
   OR EXISTS(SELECT 1 FROM source_discoveries d WHERE d.source_id=s.id AND d.video_id=e.video_id))`).bind(sourceId);
}

export function sourceMembership(env,job,lease,entries,t){
 const items=entries.map((e,i)=>({id:e.video_id??e.id,position:e.position??i+1}));
 return env.DB.prepare(`INSERT INTO episode_sources(source_id,episode_id,discovered_at,position)
  SELECT s.id,e.id,?,json_extract(item.value,'$.position') FROM json_each(?) item
  JOIN sources s ON s.id=? JOIN episodes e ON e.channel_id=s.channel_id AND e.video_id=json_extract(item.value,'$.id')
  WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?)
  ON CONFLICT(source_id,episode_id) DO UPDATE SET position=excluded.position WHERE episode_sources.position!=excluded.position`)
  .bind(t,JSON.stringify(items),job.source_id,job.id,lease,t);
}
