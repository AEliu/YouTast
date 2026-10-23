import {id,now,secret,passwordHash,hash,requireValue,HttpError} from './lib.js';
import {seedLegacyInvite} from './invitations.js';
import {resetPassword} from './passwords.js';
const stmt=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
const response=data=>Response.json(data,{headers:{'Cache-Control':'no-store'}});
const audit=(env,actor,target,action,details)=>stmt(env,'INSERT INTO admin_audit(id,actor_id,target_id,action,details,created_at) VALUES(?,?,?,?,?,?)',id(),actor,target,action,JSON.stringify(details),now());
const limit=value=>value===null||(Number.isSafeInteger(value)&&value>=0&&value<=1_000_000_000_000);
export async function adminApi(request,env,url,user,readBody,storageSql,rateLimit) {
 requireValue(user.role==='admin',403,'仅管理员可访问');
 const path=url.pathname,method=request.method;
 if(path==='/api/admin/invitations'&&method==='GET') {
  await seedLegacyInvite(env);
  const offset=Math.max(0,Math.min(100000,Math.trunc(Number(url.searchParams.get('offset')))||0));
  const rows=await stmt(env,`SELECT i.id,i.hint,i.label,i.max_uses,i.used_count,i.enabled,i.expires_at,i.legacy,i.created_at,u.username creator
   FROM invitations i LEFT JOIN users u ON u.id=i.created_by ORDER BY i.created_at DESC,i.rowid DESC LIMIT 101 OFFSET ?`,offset).all();
  return response({invitations:rows.results.slice(0,100),hasMore:rows.results.length>100,offset});
 }
 if(path==='/api/admin/invitations'&&method==='POST') {
  const b=await readBody(request);
  requireValue(Object.keys(b).every(k=>['label','max_uses','expires_at'].includes(k)),400,'未知邀请码设置');
  requireValue(typeof b.label==='string'&&b.label.length<=100&&Number.isSafeInteger(b.max_uses)&&b.max_uses>=0&&b.max_uses<=1000000,400,'备注最多100字，次数需为0–1000000的整数（0不限）');
  requireValue(b.expires_at===null||(Number.isSafeInteger(b.expires_at)&&b.expires_at>now()&&b.expires_at<=now()+315360000),400,'到期时间需在未来10年以内');
  const code=`YT-${secret().slice(0,32)}`,iid=id(),hint=code.slice(0,8)+'…'+code.slice(-4);
  await env.DB.batch([stmt(env,'INSERT INTO invitations(id,code_hash,hint,label,max_uses,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',iid,await hash(code),hint,b.label,b.max_uses,b.expires_at,user.id,now()),audit(env,user.id,null,'invite.create',{id:iid,label:b.label,max_uses:b.max_uses,expires_at:b.expires_at})]);
  return response({id:iid,code,hint});
 }
 const inviteMatch=path.match(/^\/api\/admin\/invitations\/([\w-]+)$/);
 if(inviteMatch&&method==='POST') {
  const b=await readBody(request),iid=inviteMatch[1];
  requireValue(Object.keys(b).every(k=>['label','max_uses','expires_at','enabled'].includes(k)),400,'未知邀请码设置');
  requireValue(typeof b.label==='string'&&b.label.length<=100&&Number.isSafeInteger(b.max_uses)&&b.max_uses>=0&&b.max_uses<=1000000&&typeof b.enabled==='boolean',400,'邀请码设置无效');
  requireValue(b.expires_at===null||(Number.isSafeInteger(b.expires_at)&&b.expires_at>0&&b.expires_at<=now()+315360000),400,'到期时间无效');
  const existing=await stmt(env,'SELECT id FROM invitations WHERE id=?',iid).first();requireValue(existing,404,'邀请码不存在');
  const result=await env.DB.batch([stmt(env,'UPDATE invitations SET label=?,max_uses=?,expires_at=?,enabled=? WHERE id=? AND (?=0 OR used_count<=?)',b.label,b.max_uses,b.expires_at,b.enabled?1:0,iid,b.max_uses,b.max_uses),
   stmt(env,"INSERT INTO admin_audit(id,actor_id,action,details,created_at) SELECT ?,?,'invite.update',?,? WHERE changes()=1",id(),user.id,JSON.stringify({id:iid,...b}),now())]);
  requireValue(result[0].meta.changes===1,409,'可用总次数不能小于已用次数，请刷新后重试');
  return response({ok:true});
 }
 if(path==='/api/admin/overview'&&method==='GET') {
  const rows=await env.DB.batch([
   stmt(env,`SELECT (${storageSql}) storage_bytes,(SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM users WHERE disabled=1) disabled_users,(SELECT COUNT(*) FROM channels) channels,(SELECT COUNT(*) FROM episodes WHERE object_key IS NOT NULL) ready_episodes,(SELECT COUNT(*) FROM jobs WHERE status='queued') queued_jobs,(SELECT COUNT(*) FROM jobs WHERE status='running') running_jobs,(SELECT COUNT(*) FROM jobs WHERE status='failed') failed_jobs,(SELECT COUNT(*) FROM executors WHERE last_seen>?) online_executors`,now()-400),
   stmt(env,'SELECT * FROM app_config WHERE id=1'),
   stmt(env,"SELECT day,SUM(bytes) bytes,SUM(requests) requests FROM usage_daily WHERE day>=date('now','-30 days') GROUP BY day ORDER BY day"),
   stmt(env,"SELECT COALESCE(SUM(bytes),0) bytes,COALESCE(SUM(requests),0) requests FROM usage_daily WHERE day>=date('now','start of month')"),
   stmt(env,'SELECT a.action,a.details,a.created_at,actor.username actor,target.username target FROM admin_audit a LEFT JOIN users actor ON actor.id=a.actor_id LEFT JOIN users target ON target.id=a.target_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT 50'),
  ]);
  const c=rows[1].results[0];
  return response({stats:rows[0].results[0],config:{...c,max_storage_bytes:c.max_storage_bytes??Number(env.MAX_STORAGE_BYTES),default_user_storage_bytes:c.default_user_storage_bytes??Number(env.MAX_USER_STORAGE_BYTES)},daily:rows[2].results,month:rows[3].results[0],audit:rows[4].results});
 }
 if(path==='/api/admin/users'&&method==='GET') {
  const search=(url.searchParams.get('search')||'').slice(0,40),offset=Math.max(0,Math.min(100000,Math.trunc(Number(url.searchParams.get('offset')))||0));
  const rows=await stmt(env,`WITH objects AS (
    SELECT c.user_id,e.object_key,e.size FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE e.object_key IS NOT NULL
    UNION ALL SELECT user_id,object_key,size FROM object_gc),physical AS (
    SELECT user_id,object_key,MAX(size) size FROM objects GROUP BY user_id,object_key)
    SELECT u.id,u.username,u.role,u.disabled,u.created_at,u.storage_limit_bytes,u.monthly_transfer_limit_bytes,
      (SELECT COALESCE(SUM(size),0) FROM physical WHERE user_id=u.id) storage_bytes,
      (SELECT COALESCE(SUM(bytes),0) FROM usage_daily WHERE user_id=u.id AND day>=date('now','start of month')) transfer_bytes,
      (SELECT COUNT(*) FROM channels WHERE user_id=u.id) channels,
      (SELECT COUNT(*) FROM executors WHERE user_id=u.id) executors
    FROM users u WHERE u.username LIKE ? ORDER BY u.created_at,u.id LIMIT 101 OFFSET ?`,'%'+search+'%',offset).all();
  return response({users:rows.results.slice(0,100),hasMore:rows.results.length>100,offset});
 }
 if(path==='/api/admin/config'&&method==='POST') {
  const b=await readBody(request);
  requireValue(Object.keys(b).every(k=>['max_storage_bytes','default_user_storage_bytes','default_monthly_transfer_bytes','max_monthly_transfer_bytes','registration_enabled'].includes(k)),400,'未知站点设置');
  for(const key of ['max_storage_bytes','default_user_storage_bytes','default_monthly_transfer_bytes','max_monthly_transfer_bytes'])requireValue(b[key]!==null&&limit(b[key]),400,'额度需为0–1TB的整数字节');
  requireValue(typeof b.registration_enabled==='boolean',400,'注册开关无效');
  await env.DB.batch([stmt(env,'UPDATE app_config SET max_storage_bytes=?,default_user_storage_bytes=?,default_monthly_transfer_bytes=?,max_monthly_transfer_bytes=?,registration_enabled=? WHERE id=1',b.max_storage_bytes,b.default_user_storage_bytes,b.default_monthly_transfer_bytes,b.max_monthly_transfer_bytes,b.registration_enabled?1:0),audit(env,user.id,null,'config.update',b)]);
  return response({ok:true});
 }
 if(path==='/api/admin/users'&&method==='POST') {
  const b=await readBody(request);
  requireValue(typeof b.username==='string'&&/^[a-zA-Z0-9_-]{3,40}$/.test(b.username),400,'用户名格式无效');
  requireValue(['user','admin'].includes(b.role),400,'角色无效');
  const password=secret(),salt=secret(),uid=id();
  const result=await env.DB.batch([stmt(env,'INSERT OR IGNORE INTO users(id,username,salt,password_hash,created_at,role) VALUES(?,?,?,?,?,?)',uid,b.username.toLowerCase(),salt,await passwordHash(password,salt),now(),b.role),
   stmt(env,"INSERT INTO admin_audit(id,actor_id,target_id,action,details,created_at) SELECT ?,?,?,'user.create',?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=?)",id(),user.id,uid,JSON.stringify({role:b.role}),now(),uid)]);
  requireValue(result[0].meta.changes===1,409,'用户名已存在');
  return response({id:uid,username:b.username.toLowerCase(),password});
 }
 const match=path.match(/^\/api\/admin\/users\/([\w-]+)(?:\/(logout|password))?$/);
 if(match&&method==='POST') {
  const target=await stmt(env,'SELECT id FROM users WHERE id=?',match[1]).first();requireValue(target,404,'用户不存在');
  if(match[2]==='logout') {
   await env.DB.batch([stmt(env,'DELETE FROM sessions WHERE user_id=?',target.id),audit(env,user.id,target.id,'user.logout',{})]);
   return response({ok:true});
  }
  if(match[2]==='password'){
   await rateLimit(request,env);
   const password=await resetPassword(env,user,target.id,await readBody(request));
   return response({ok:true,password});
  }
  const b=await readBody(request);
  requireValue(Object.keys(b).every(k=>['role','disabled','storage_limit_bytes','monthly_transfer_limit_bytes'].includes(k)),400,'未知用户设置');
  requireValue(['user','admin'].includes(b.role)&&typeof b.disabled==='boolean'&&limit(b.storage_limit_bytes)&&limit(b.monthly_transfer_limit_bytes),400,'用户设置无效');
  try {
   await env.DB.batch([
    stmt(env,'UPDATE users SET role=?,disabled=?,storage_limit_bytes=?,monthly_transfer_limit_bytes=? WHERE id=?',b.role,b.disabled?1:0,b.storage_limit_bytes,b.monthly_transfer_limit_bytes,target.id),
    stmt(env,'DELETE FROM sessions WHERE user_id=? AND ?=1',target.id,b.disabled?1:0),
    stmt(env,"UPDATE jobs SET status='queued',executor_id=NULL,lease_token=NULL,lease_until=NULL,reserved_bytes=0,available_at=?,updated_at=? WHERE user_id=? AND status='running' AND ?=1",now()+60,now(),target.id,b.disabled?1:0),
    audit(env,user.id,target.id,'user.update',b),
   ]);
  } catch(error) {if(String(error.message).includes('last_admin'))throw new HttpError(409,'必须保留至少一个启用的管理员');throw error;}
  return response({ok:true});
 }
 throw new HttpError(404,'管理接口不存在');
}
