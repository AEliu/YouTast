import {requireValue} from './lib.js';
export const EXECUTION_DEFAULTS={concurrency:1,start_interval:60,request_interval:2,download_wait:10,cooldown_seconds:1800,paused:false};
export function validateExecution(value) {
 requireValue(value&&typeof value==='object'&&!Array.isArray(value),400,'执行器设置无效');
 requireValue(Object.keys(value).every(key=>Object.hasOwn(EXECUTION_DEFAULTS,key)),400,'未知执行器设置');
 for(const [key,min,max] of [['concurrency',1,3],['start_interval',0,3600],['request_interval',0,30],['download_wait',0,60],['cooldown_seconds',60,86400]])requireValue(Number.isInteger(value[key])&&value[key]>=min&&value[key]<=max,400,`${key} 需为 ${min}–${max} 的整数`);
 requireValue(typeof value.paused==='boolean',400,'暂停设置无效');
 return value;
}
export async function executionPolicy(env,uid) {
 const row=await env.DB.prepare('SELECT * FROM execution_policy WHERE user_id=?').bind(uid).first();
 const {user_id,...policy}=row||{...EXECUTION_DEFAULTS,next_start_at:0,cooldown_until:0};
 return {...policy,paused:!!policy.paused};
}
