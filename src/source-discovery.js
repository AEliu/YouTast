import {requireValue} from './lib.js';
import {sourceMembership} from './source-controls.js';

export const PLAYLIST_INVENTORY_LIMIT=10000;
export function validateInventory(items){
 requireValue(Array.isArray(items)&&items.length<=PLAYLIST_INVENTORY_LIMIT,400,'播放列表最多支持完整检测10000条，请拆分更大的列表');
 const seen=new Set();let previous=0;
 for(const item of items){
  requireValue(item&&typeof item.id==='string'&&/^[\w-]{11}$/.test(item.id)&&!seen.has(item.id)&&Number.isInteger(item.position)&&item.position>previous&&item.position<=1000000,400,'播放列表清单无效');
  seen.add(item.id);previous=item.position;
 }
}

export async function inventoryBatch(env,job,lease,items,limit,t){
 const live="EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?)";
 const snapshot=JSON.stringify(items),prepare=(sql,...values)=>env.DB.prepare(sql).bind(...values);
 const eligible=`FROM json_each(?) item JOIN source_discoveries d ON d.source_id=? AND d.video_id=json_extract(item.value,'$.id') WHERE d.pending=1`;
 const result=await env.DB.batch([
  sourceMembership(env,job,lease,items,t),
  prepare(`INSERT INTO source_discoveries(source_id,video_id,pending)
   SELECT s.id,json_extract(item.value,'$.id'),CASE WHEN s.discovery_initialized=1 OR CAST(item.key AS INTEGER)<? THEN 1 ELSE 0 END
   FROM json_each(?) item JOIN sources s ON s.id=? AND s.kind='playlist' WHERE ${live}
   ON CONFLICT(source_id,video_id) DO NOTHING`,limit,snapshot,job.source_id,job.id,lease,t),
  prepare(`UPDATE sources SET discovery_initialized=1 WHERE id=? AND ${live}`,job.source_id,job.id,lease,t),
  // Keep playlist presentation positions current without changing added order,
  // audio, or rows whose earliest provenance belongs to another source.
  prepare(`UPDATE episodes AS episode SET source_position=(SELECT json_extract(item.value,'$.position') FROM json_each(?) item WHERE json_extract(item.value,'$.id')=episode.video_id)
   WHERE channel_id=? AND source_kind='playlist' AND source_order=(SELECT sort_order FROM sources WHERE id=?)
   AND EXISTS(SELECT 1 FROM json_each(?) item WHERE json_extract(item.value,'$.id')=episode.video_id AND json_extract(item.value,'$.position')!=episode.source_position)
   AND ${live}`,snapshot,job.channel_id,job.source_id,snapshot,job.id,lease,t),
  prepare(`UPDATE jobs SET discovery_lease=?,
   discovery_selection=(SELECT json_group_array(video_id) FROM (SELECT d.video_id ${eligible} ORDER BY CAST(item.key AS INTEGER) LIMIT ?)),
   discovery_more=((SELECT COUNT(*) ${eligible})>?) WHERE id=? AND lease_token=? AND status='running' AND lease_until>?`,lease,snapshot,job.source_id,limit,snapshot,job.source_id,limit,job.id,lease,t),
  prepare("SELECT discovery_selection,discovery_more FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?",job.id,lease,t),
 ]);
 const row=result.at(-1).results[0];requireValue(row,409,'扫描租约已失效');
 const positions=new Map(items.map(item=>[item.id,item.position]));
 return {selected:JSON.parse(row.discovery_selection).map(id=>({id,position:positions.get(id)})),has_more:!!row.discovery_more};
}

export function acknowledgeInventory(env,job,lease,entries,t){
 requireValue(job.discovery_lease===lease&&job.discovery_selection!=null,409,'请先完整比对播放列表');
 const selected=JSON.parse(job.discovery_selection),ids=new Set(entries.map(e=>e.video_id));
 requireValue(ids.size===selected.length&&selected.every(id=>ids.has(id)),409,'扫描结果与待收录批次不一致');
 return env.DB.prepare(`UPDATE source_discoveries SET pending=0 WHERE source_id=? AND video_id IN(SELECT value FROM json_each(?))
  AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?)`).bind(job.source_id,job.discovery_selection,job.id,lease,t);
}
