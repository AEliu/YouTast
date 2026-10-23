import {now} from './lib.js';
export async function reconcileWindow(env,channelId,userId=null) {
 const t=now(),scope=channelId?'channel_id=?':'channel_id IN(SELECT id FROM channels WHERE user_id=?)',owner=channelId||userId;
 await env.DB.batch([
  env.DB.prepare(`UPDATE jobs SET status='failed',error='不在最新节目范围，暂不转换',updated_at=?
   WHERE ${scope} AND kind='transcode' AND status='queued'
   AND episode_id NOT IN(SELECT id FROM active_episode_window WHERE ${scope})`).bind(t,owner,owner),
  env.DB.prepare(`UPDATE jobs SET status='queued',error=NULL,attempts=0,available_at=?,updated_at=?
   WHERE ${scope} AND kind='transcode' AND status='failed' AND error='不在最新节目范围，暂不转换'
   AND episode_id IN(SELECT id FROM active_episode_window WHERE ${scope})
   AND EXISTS(SELECT 1 FROM episodes e WHERE e.id=jobs.episode_id AND e.expired_at IS NULL)`).bind(t,t,owner,owner),
  env.DB.prepare(`INSERT OR IGNORE INTO jobs(id,user_id,channel_id,episode_id,kind,available_at,created_at,updated_at)
   SELECT lower(hex(randomblob(16))),c.user_id,e.channel_id,e.id,'transcode',?,?,? FROM episodes e JOIN channels c ON c.id=e.channel_id
   WHERE e.${scope} AND e.object_key IS NULL AND e.expired_at IS NULL
   AND e.id IN(SELECT id FROM active_episode_window WHERE ${scope})`).bind(t,t,t,owner,owner),
 ]);
}
