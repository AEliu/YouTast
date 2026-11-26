import {requireValue} from './lib.js';
export const EXECUTION_DEFAULTS={concurrency:1,start_interval:60,scan_concurrency:1,scan_start_interval:15,request_interval:2,download_wait:10,cooldown_seconds:1800,paused:false,skip_paid:true};
export function validateExecution(value) {
 requireValue(value&&typeof value==='object'&&!Array.isArray(value),400,'执行器设置无效');
 requireValue(Object.keys(value).every(key=>Object.hasOwn(EXECUTION_DEFAULTS,key)),400,'未知执行器设置');
 for(const [key,min,max] of [['concurrency',1,3],['start_interval',0,3600],['request_interval',0,30],['download_wait',0,60],['cooldown_seconds',60,86400]])requireValue(Number.isInteger(value[key])&&value[key]>=min&&value[key]<=max,400,`${key} 需为 ${min}–${max} 的整数`);
 for(const [key,min,max] of [['scan_concurrency',1,3],['scan_start_interval',0,3600]])if(Object.hasOwn(value,key))requireValue(Number.isInteger(value[key])&&value[key]>=min&&value[key]<=max,400,`${key} 需为 ${min}–${max} 的整数`);
 requireValue(typeof value.paused==='boolean',400,'暂停设置无效');
 if(Object.hasOwn(value,'skip_paid'))requireValue(typeof value.skip_paid==='boolean',400,'专享视频设置无效');
 return value;
}
export async function executionPolicy(env,uid) {
 const row=await env.DB.prepare('SELECT * FROM execution_policy WHERE user_id=?').bind(uid).first();
 const {user_id,...policy}=row||{...EXECUTION_DEFAULTS,next_start_at:0,scan_next_start_at:0,cooldown_until:0};
 return {...policy,paused:!!policy.paused,skip_paid:Boolean(policy.skip_paid??true)};
}

export async function claimWait(env,uid,policy,t,fallback=60) {
 if(policy.paused)return {retryAfter:60};
 if(policy.cooldown_until>t)return {retryAfter:policy.cooldown_until-t};
 if(policy.scan_next_start_at>t||policy.next_start_at>t) {
  const {start_at}=await env.DB.prepare(`SELECT MIN(CASE WHEN kind='scan' THEN ? ELSE ? END) start_at FROM jobs
   WHERE user_id=? AND status='queued' AND available_at<=?
   AND ((kind='scan' AND ?>?) OR (kind='transcode' AND ?>?))`)
   .bind(policy.scan_next_start_at,policy.next_start_at,uid,t,policy.scan_next_start_at,t,policy.next_start_at,t).first();
  if(start_at>t)return {retryAfter:start_at-t,retryReason:'start_interval'};
 }
 return {retryAfter:fallback};
}
