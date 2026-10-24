import {taskSearch} from './task-actions.js';
import {taskView,taskCondition,taskStateSql,taskCountsSql} from './task-view.js';
import {windowCte} from './window-query.js';
import {requireValue} from './lib.js';
import {effectiveSortMode,episodeOrderSql} from './sorting.js';
import {listOptions,pageSql,pageBindings,pageInfo,episodeSearch} from './listing.js';

export async function channelDetail(env,channel,url) {
 const tab=url.searchParams.get('tab')||'episodes';
 const options=listOptions(url),{query}=options;
 requireValue(['episodes','sources','jobs','archive'].includes(tab),400,'详情分类无效');
 const tasks=tab==='jobs'?taskView(url):'current';
 const window=windowCte('id=?');
 const visible="id IN(SELECT id FROM scoped_window WHERE channel_id=?)";
 const filter=tab==='archive'?`NOT (${visible}) AND object_key IS NOT NULL`:visible;
 const search=episodeSearch(query,'e');
 const rows=`SELECT e.* FROM episodes e WHERE channel_id=? AND ${filter} AND ${search.sql}`;
 const queries=[
  env.DB.prepare(`${window} SELECT COUNT(*) episodes,COALESCE(SUM(object_key IS NOT NULL),0) ready FROM episodes WHERE channel_id=? AND ${visible}`).bind(channel.id,channel.id,channel.id),
  env.DB.prepare(`${window} SELECT COUNT(*) archived FROM episodes WHERE channel_id=? AND NOT (${visible}) AND object_key IS NOT NULL`).bind(channel.id,channel.id,channel.id),
  env.DB.prepare(`SELECT ${taskCountsSql()} FROM jobs j WHERE j.channel_id=?`).bind(channel.id),
  env.DB.prepare('SELECT * FROM sources WHERE channel_id=? ORDER BY sort_order,id').bind(channel.id),
 ];
 if(tab==='episodes'||tab==='archive'){
  // Calculate the missing-date fallback before filtering so search preserves
  // the channel's ordering even when only some author rows match.
  const ranked=`${window}, all_visible AS(SELECT * FROM episodes WHERE channel_id=? AND ${filter}),ranked AS(SELECT *,MAX(CASE WHEN source_kind='author' AND published_at IS NULL THEN 1 ELSE 0 END) OVER(PARTITION BY source_order) AS missing_author_dates FROM all_visible),visible AS(SELECT e.* FROM ranked e WHERE ${search.sql})`;
  queries.push(env.DB.prepare(`${ranked} SELECT *,(SELECT dismissed_at FROM jobs WHERE episode_id=visible.id AND kind='transcode') task_dismissed FROM visible ORDER BY ${episodeOrderSql(effectiveSortMode(channel))} ${pageSql}`).bind(channel.id,channel.id,channel.id,...search.values,...pageBindings(options)));
  queries.push(env.DB.prepare(`${window}, visible AS(${rows}) SELECT COUNT(*) total FROM visible`).bind(channel.id,channel.id,channel.id,...search.values));
 }
 if(tab==='jobs'){
  const condition=taskSearch(query,true);
  const values=[channel.id,...condition.values];
  const jobs=`SELECT j.id,j.kind,j.status,${taskStateSql()} display_status,j.attempts,j.reused,CASE WHEN j.status='done' THEN NULL ELSE j.error END error,j.created_at,j.updated_at,e.title episode_title FROM jobs j JOIN channels c ON c.id=j.channel_id LEFT JOIN episodes e ON e.id=j.episode_id WHERE j.channel_id=? AND ${taskCondition(tasks)} AND ${condition.sql}`;
  queries.push(env.DB.prepare(`WITH visible AS(${jobs}) SELECT * FROM visible ORDER BY created_at DESC,id DESC ${pageSql}`).bind(...values,...pageBindings(options)));
  queries.push(env.DB.prepare(`WITH visible AS(${jobs}) SELECT COUNT(*) total,COALESCE(SUM(display_status='failed'),0) failed_total FROM visible`).bind(...values));
 }
 const result=await env.DB.batch(queries);
 const counts={...result[0].results[0],...result[1].results[0],...result[2].results[0]};
 const sources=result[3].results;
 const total=tab==='sources'?sources.length:result[5].results[0].total;
 return {channel:{...channel,episode_count:counts.ready,archived_count:counts.archived},counts,sources,
  episodes:['episodes','archive'].includes(tab)?result[4].results:[],jobs:tab==='jobs'?result[4].results:[],
  tab,...(tab==='jobs'?{tasks,failedTotal:result[5].results[0].failed_total}:{}),query:tab==='sources'?'':query,page:tab==='sources'?{offset:0,limit:options.limit,total,hasMore:false}:pageInfo(options,total)};
}
