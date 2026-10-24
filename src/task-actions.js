import {now,requireValue} from './lib.js';
import {taskStateSql} from './task-view.js';

export function taskSearch(query,channelOnly=false) {
 if(!query)return {sql:'1=1',values:[]};
 return channelOnly?
  {sql:'instr(lower(COALESCE(e.title,c.title)),lower(?))>0',values:[query]}:
  {sql:"(instr(lower(COALESCE(e.title,'')),lower(?))>0 OR instr(lower(c.title),lower(?))>0)",values:[query,query]};
}

async function selection(env,user,input) {
 requireValue(input&&typeof input==='object'&&!Array.isArray(input),400,'批量操作参数无效');
 requireValue(Object.keys(input).every(k=>['action','ids','all','channel_id','query','expected_count','expected_matched'].includes(k)),400,'批量操作包含未知参数');
 requireValue(['retry','dismiss'].includes(input.action),400,'批量操作无效');
 const selected=Array.isArray(input.ids);
 requireValue(selected?input.all===undefined&&input.ids.length>0&&input.ids.length<=80&&input.ids.every(id=>typeof id==='string'&&/^[\w-]{1,100}$/.test(id))&&new Set(input.ids).size===input.ids.length:input.all===true&&input.ids===undefined,400,'请选择任务或明确操作全部匹配的失败任务');
 requireValue(input.query===undefined||typeof input.query==='string',400,'搜索内容无效');
 const query=(input.query||'').trim();requireValue(query.length<=200,400,'搜索内容不能超过200个字符');
 if(input.channel_id!==undefined){
  requireValue(typeof input.channel_id==='string'&&/^[\w-]{1,100}$/.test(input.channel_id),400,'频道无效');
  const own=await env.DB.prepare('SELECT id FROM channels WHERE id=? AND user_id=?').bind(input.channel_id,user.id).first();
  requireValue(own,404,'频道不存在');
 }
 const search=taskSearch(query,!!input.channel_id);
 const values=[user.id,user.id,...(input.channel_id?[input.channel_id]:[]),...search.values,...(selected?input.ids:[])];
 const cte=`WITH matched AS MATERIALIZED (
  SELECT j.id,j.kind,j.source_id,j.created_at FROM jobs j JOIN channels c ON c.id=j.channel_id
  LEFT JOIN episodes e ON e.id=j.episode_id
  WHERE j.user_id=? AND c.user_id=? AND ${taskStateSql()}='failed'
  ${input.channel_id?'AND j.channel_id=?':''} AND ${search.sql}
  ${selected?`AND j.id IN(${input.ids.map(()=>'?').join(',')})`:''}
 ), ranked AS (
  SELECT m.*,ROW_NUMBER() OVER(PARTITION BY CASE WHEN kind='scan' AND source_id IS NOT NULL THEN 'source:'||source_id ELSE 'job:'||id END ORDER BY created_at DESC,id DESC) rank
  FROM matched m WHERE kind!='scan' OR source_id IS NULL OR (
   EXISTS(SELECT 1 FROM sources s WHERE s.id=m.source_id AND s.paused=0)
   AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.source_id=m.source_id AND active.kind='scan' AND active.status IN('queued','running'))
  )
 ), eligible AS MATERIALIZED (
  ${input.action==='dismiss'?'SELECT id FROM matched':'SELECT id FROM ranked WHERE rank=1'}
 )`;
 return {cte,values};
}

export async function previewTaskAction(env,user,input) {
 const {cte,values}=await selection(env,user,input);
 return env.DB.prepare(`${cte} SELECT (SELECT COUNT(*) FROM matched) matched,(SELECT COUNT(*) FROM eligible) count`).bind(...values).first();
}

export async function applyTaskAction(env,user,input) {
 requireValue(Number.isSafeInteger(input?.expected_count)&&input.expected_count>0&&Number.isSafeInteger(input.expected_matched)&&input.expected_matched>=input.expected_count,400,'请先确认本次操作的任务数量');
 const {cte,values}=await selection(env,user,input),t=now();
 const updates=input.action==='retry'?"status='queued',attempts=0,error=NULL,available_at=?,updated_at=?":"dismissed_at=?,updated_at=?";
 const result=await env.DB.prepare(`${cte} UPDATE jobs SET ${updates}
  WHERE id IN(SELECT id FROM eligible) AND status='failed' AND dismissed_at IS NULL
  AND (SELECT COUNT(*) FROM eligible)=? AND (SELECT COUNT(*) FROM matched)=?`)
  .bind(...values,t,t,input.expected_count,input.expected_matched).run();
 const changed=result.meta.changes;
 requireValue(changed>0,409,'失败任务已发生变化，请刷新后重新确认');
 return {ok:true,changed};
}
