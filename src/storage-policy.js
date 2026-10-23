import {secret,now} from './lib.js';

export async function cleanupOverQuota(env,cleanupObjects,allStorageBytes,userStorageBytes) {
 const rows=await env.DB.prepare(`WITH objects AS (
  SELECT c.user_id,e.object_key,e.size FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE e.object_key IS NOT NULL
  UNION ALL SELECT user_id,object_key,size FROM object_gc
 ),physical AS(SELECT user_id,object_key,MAX(size) size FROM objects GROUP BY user_id,object_key),
 usage AS(SELECT user_id,SUM(size) bytes FROM physical GROUP BY user_id)
 SELECT u.id FROM users u JOIN usage own ON own.user_id=u.id JOIN app_config a ON a.id=1
 WHERE u.disabled=0 AND json_extract(u.settings,'$.storage_cleanup')='oldest'
 AND (own.bytes>COALESCE(u.storage_limit_bytes,a.default_user_storage_bytes,?)
  OR (SELECT COALESCE(SUM(size),0) FROM physical)>COALESCE(a.max_storage_bytes,?))
 AND EXISTS(SELECT 1 FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE c.user_id=u.id AND e.object_key IS NOT NULL)
 ORDER BY u.created_at,u.id LIMIT 2`).bind(Number(env.MAX_USER_STORAGE_BYTES),Number(env.MAX_STORAGE_BYTES)).all();
 for(const user of rows.results)await makeSpace(env,user.id,0,cleanupObjects,allStorageBytes,userStorageBytes);
}

// Free this user's opted-in audio only. R2 deletion must finish before upload
// reservations see free space. A global cleanup lock avoids double eviction.
export async function makeSpace(env,uid,incoming,cleanupObjects,allStorageBytes,userStorageBytes) {
 const user=await env.DB.prepare('SELECT settings FROM users WHERE id=?').bind(uid).first();
 if(JSON.parse(user?.settings||'{}').storage_cleanup!=='oldest')return;
 const token=secret();
 const lock=await env.DB.prepare(`INSERT INTO storage_cleanup_locks(lock_key,token,lease_until) VALUES('quota',?,?)
  ON CONFLICT(lock_key) DO UPDATE SET token=excluded.token,lease_until=excluded.lease_until WHERE lease_until<=?
  RETURNING token`).bind(token,now()+300,now()).first();
 if(!lock)return;
 try {
  await cleanupObjects(env,uid);
  const rows=await env.DB.batch([
   env.DB.prepare(`SELECT (${allStorageBytes}) bytes`),
   env.DB.prepare(`SELECT (${userStorageBytes}) bytes`).bind(uid,uid),
   env.DB.prepare(`SELECT COALESCE(a.max_storage_bytes,?) global_cap,COALESCE(u.storage_limit_bytes,a.default_user_storage_bytes,?) user_cap FROM app_config a JOIN users u ON u.id=? WHERE a.id=1`).bind(Number(env.MAX_STORAGE_BYTES),Number(env.MAX_USER_STORAGE_BYTES),uid),
  ]);
  const total=rows[0].results[0].bytes,own=rows[1].results[0].bytes,caps=rows[2].results[0];
  if(incoming>caps.global_cap||incoming>caps.user_cap)return;
  const need=Math.max(0,total+incoming-caps.global_cap,own+incoming-caps.user_cap);
  if(!need)return;
  const candidates=await env.DB.prepare(`SELECT e.object_key,MAX(e.size) size,
   MAX(CASE WHEN w.id IS NULL THEN 0 ELSE 1 END) in_window,MAX(COALESCE(e.published_at,e.ready_at,e.created_at)) age
   FROM episodes e JOIN channels c ON c.id=e.channel_id LEFT JOIN active_episode_window w ON w.id=e.id
   WHERE c.user_id=? AND e.object_key IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM jobs j JOIN episodes busy ON busy.id=j.episode_id WHERE busy.object_key=e.object_key AND j.status='running' AND j.lease_until>?)
   AND NOT EXISTS(SELECT 1 FROM episodes other JOIN channels owner ON owner.id=other.channel_id WHERE other.object_key=e.object_key AND owner.user_id!=?)
   GROUP BY e.object_key ORDER BY in_window,age,e.object_key LIMIT 50`).bind(uid,now(),uid).all();
  let freed=0;const keys=[];
  for(const object of candidates.results){keys.push(object.object_key);freed+=object.size;if(freed>=need)break;}
  if(!keys.length)return;
  const placeholders=keys.map(()=>'?').join(','),t=now();
  const safe=`EXISTS(SELECT 1 FROM storage_cleanup_locks WHERE lock_key='quota' AND token=? AND lease_until>unixepoch())`;
  // Exclude a key again if metadata work started after the candidate snapshot.
  const idle=`NOT EXISTS(SELECT 1 FROM jobs active JOIN episodes busy ON busy.id=active.episode_id WHERE busy.object_key=episodes.object_key AND active.status='running' AND active.lease_until>unixepoch())`;
  await env.DB.batch([
   env.DB.prepare(`UPDATE jobs SET status='failed',error='空间不足，旧音频已自动清理',updated_at=? WHERE status IN('queued','done','failed') AND episode_id IN(
    SELECT id FROM episodes WHERE object_key IN(${placeholders}) AND ${idle}) AND ${safe}`).bind(t,...keys,token),
   env.DB.prepare(`UPDATE episodes SET object_key=NULL,size=0,expired_at=?,cleanup_reason='quota' WHERE object_key IN(${placeholders}) AND ${idle} AND ${safe}`).bind(t,...keys,token),
  ]);
  await cleanupObjects(env,uid);
 } finally {
  await env.DB.prepare("DELETE FROM storage_cleanup_locks WHERE lock_key='quota' AND token=?").bind(token).run();
 }
}
