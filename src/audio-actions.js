import {requireValue} from './lib.js';

// Remove only explicitly selected, owned audio. The two statements run in a
// single D1 transaction so an active conversion cannot be changed halfway.
export async function deleteSelectedAudio(env, user, input) {
 requireValue(input && typeof input==='object' && !Array.isArray(input) && Object.keys(input).every(k=>k==='ids'),400,'批量删除参数无效');
 const ids=input.ids;
 requireValue(Array.isArray(ids) && ids.length>0 && ids.length<=80 && ids.every(id=>typeof id==='string' && /^[\w-]{1,100}$/.test(id)) && new Set(ids).size===ids.length,400,'请选择 1–80 个不同的单集');
 const slots=ids.map(()=>'?').join(',');
 const eligible=`SELECT e.id FROM episodes e JOIN channels c ON c.id=e.channel_id
  WHERE c.user_id=? AND e.id IN(${slots}) AND e.object_key IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.episode_id=e.id AND active.status='running')`;
 const result=await env.DB.batch([
  env.DB.prepare(`UPDATE jobs SET status='failed',error='音频已由用户删除' WHERE status!='running' AND user_id=? AND episode_id IN(${eligible})`).bind(user.id,user.id,...ids),
  env.DB.prepare(`UPDATE episodes SET object_key=NULL,size=0,expired_at=unixepoch(),cleanup_reason='manual' WHERE id IN(${eligible}) RETURNING id`).bind(user.id,...ids),
 ]);
 const changed=result[1].results.length;
 return {ok:true,changed,skipped:ids.length-changed};
}
