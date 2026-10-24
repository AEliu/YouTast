import {taskSearch} from './task-actions.js';
import {taskView,taskCondition,taskStateSql,taskCountsSql} from './task-view.js';
import {windowCte} from './window-query.js';
import {requireValue} from './lib.js';

export function listOptions(url) {
 const raw=url.searchParams.get('offset')||'0',offset=Number(raw);
 requireValue(/^\d+$/.test(raw)&&Number.isSafeInteger(offset)&&offset<=1000000,400,'分页位置无效');
 const query=(url.searchParams.get('q')||'').trim();
 requireValue(query.length<=200,400,'搜索内容不能超过 200 个字符');
 return {offset,limit:30,query};
}

// D1 binds JS numbers as real values; explicitly truncate page arithmetic.
// The visible CTE and the total query are executed in one batch snapshot.
export const pageSql=`LIMIT ? OFFSET CASE WHEN ? >= (SELECT COUNT(*) FROM visible) THEN MAX(0,CAST(((SELECT COUNT(*) FROM visible)-1)/? AS INTEGER))*? ELSE ? END`;
export const pageBindings=({offset,limit})=>[limit,offset,limit,limit,offset];
export function pageInfo({offset,limit},total) {
 const current=total===0?0:offset>=total?Math.floor((total-1)/limit)*limit:offset;
 return {offset:current,limit,total,hasMore:current+limit<total};
}

// instr treats %, _ and backslashes literally. Only constant SQL fragments
// are generated here; every search value is a bound parameter.
export function episodeSearch(query,alias='e') {
 if(!query)return {sql:'1=1',values:[]};
 const metadata=`CASE WHEN json_valid(${alias}.metadata) THEN ${alias}.metadata ELSE '{}' END`;
 const fields=[`${alias}.title`,`${alias}.video_id`,`json_extract(${metadata},'$.author')`,`json_extract(${metadata},'$.description')`];
 return {sql:'('+fields.map(f=>`instr(lower(COALESCE(${f},'')),lower(?))>0`).join(' OR ')+')',values:fields.map(()=>query)};
}

export async function userCollection(env,user,url,kind) {
 const options=listOptions(url),{query}=options;
 const tasks=kind==='jobs'?taskView(url):'current';
 let base,values;
 const prefix=kind==='episodes'?windowCte('user_id=?')+',':'WITH';
 if(kind==='episodes'){
  const search=episodeSearch(query);
  base=`SELECT e.*,c.title channel_title,c.feed_token FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE c.user_id=? AND e.id IN(SELECT id FROM scoped_window) AND ${search.sql}`;
  values=[user.id,user.id,...search.values];
 }else{
  const search=taskSearch(query);
  base=`SELECT j.id,j.kind,j.status,${taskStateSql()} display_status,j.attempts,j.reused,CASE WHEN j.status='done' THEN NULL ELSE j.error END error,j.created_at,j.updated_at,j.channel_id,c.title channel_title,e.title episode_title FROM jobs j JOIN channels c ON c.id=j.channel_id LEFT JOIN episodes e ON e.id=j.episode_id WHERE j.user_id=? AND c.user_id=? AND ${taskCondition(tasks)} AND ${search.sql}`;
  values=[user.id,user.id,...search.values];
 }
 const results=await env.DB.batch([
  env.DB.prepare(`${prefix} visible AS(${base}) SELECT COUNT(*) total${kind==='jobs'?",COALESCE(SUM(display_status='failed'),0) failed_total":''} FROM visible`).bind(...values),
  env.DB.prepare(`${prefix} visible AS(${base}) SELECT *${kind==='episodes'?",(SELECT dismissed_at FROM jobs WHERE episode_id=visible.id AND kind='transcode') task_dismissed":''} FROM visible ORDER BY created_at DESC,id ${kind==='jobs'?'DESC':'ASC'} ${pageSql}`).bind(...values,...pageBindings(options)),
  ...(kind==='jobs'?[env.DB.prepare(`SELECT ${taskCountsSql()} FROM jobs j JOIN channels c ON c.id=j.channel_id WHERE j.user_id=? AND c.user_id=?`).bind(user.id,user.id)]:[]),
 ]);
 return {[kind]:results[1].results,page:pageInfo(options,results[0].results[0].total),query,...(kind==='jobs'?{tasks,failedTotal:results[0].results[0].failed_total,counts:results[2].results[0]}:{})};
}
