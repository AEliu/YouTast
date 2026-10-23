import {requireValue} from './lib.js';
import {effectiveSortMode,episodeOrderSql} from './sorting.js';

export async function channelDetail(env,channel,url) {
 const tab=url.searchParams.get('tab')||'episodes';
 const raw=url.searchParams.get('offset')||'0',offset=Number(raw),limit=30;
 requireValue(['episodes','sources','jobs','archive'].includes(tab),400,'详情分类无效');
 requireValue(/^\d+$/.test(raw)&&Number.isSafeInteger(offset)&&offset<=1000000,400,'分页位置无效');
 const visible="id IN(SELECT id FROM active_episode_window WHERE channel_id=?)";
 const filter=tab==='archive'?`NOT (${visible}) AND object_key IS NOT NULL`:visible;
 const queries=[
  env.DB.prepare(`SELECT COUNT(*) episodes,COALESCE(SUM(object_key IS NOT NULL),0) ready FROM episodes WHERE channel_id=? AND ${visible}`).bind(channel.id,channel.id),
  env.DB.prepare(`SELECT COUNT(*) archived FROM episodes WHERE channel_id=? AND NOT (${visible}) AND object_key IS NOT NULL`).bind(channel.id,channel.id),
  env.DB.prepare("SELECT COUNT(*) jobs,COALESCE(SUM(status IN('queued','running')),0) active FROM jobs WHERE channel_id=?").bind(channel.id),
  env.DB.prepare('SELECT * FROM sources WHERE channel_id=? ORDER BY sort_order,id').bind(channel.id),
 ];
 if(tab==='episodes'||tab==='archive')queries.push(env.DB.prepare(`WITH visible AS(SELECT * FROM episodes WHERE channel_id=? AND ${filter}),ranked AS(SELECT *,MAX(CASE WHEN source_kind='author' AND published_at IS NULL THEN 1 ELSE 0 END) OVER(PARTITION BY source_order) AS missing_author_dates FROM visible) SELECT * FROM ranked ORDER BY ${episodeOrderSql(effectiveSortMode(channel))} LIMIT ? OFFSET ?`).bind(channel.id,channel.id,limit,offset));
 if(tab==='jobs')queries.push(env.DB.prepare("SELECT j.id,j.kind,j.status,j.attempts,j.reused,j.error,j.created_at,j.updated_at,e.title episode_title FROM jobs j LEFT JOIN episodes e ON e.id=j.episode_id WHERE j.channel_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT ? OFFSET ?").bind(channel.id,limit,offset));
 const result=await env.DB.batch(queries);
 const counts={...result[0].results[0],...result[1].results[0],...result[2].results[0]};
 const sources=result[3].results;
 const total=tab==='jobs'?counts.jobs:tab==='archive'?counts.archived:tab==='sources'?sources.length:counts.episodes;
 return {channel:{...channel,episode_count:counts.ready,archived_count:counts.archived},counts,sources,
  episodes:['episodes','archive'].includes(tab)?result[4].results:[],jobs:tab==='jobs'?result[4].results:[],
  tab,page:{offset,limit,total,hasMore:offset+limit<total}};
}
