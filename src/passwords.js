import {id,now,secret,passwordHash,requireValue} from './lib.js';
const stmt=(env,sql,...values)=>env.DB.prepare(sql).bind(...values);

function passwordValue(value) {
 requireValue(typeof value==='string'&&value.length>=12&&value.length<=128,400,'密码需为 12–128 个字符');
}
async function verifiedCredentials(env,user,password) {
 passwordValue(password);
 const row=await stmt(env,'SELECT salt,password_hash,role,disabled FROM users WHERE id=?',user.id).first();
 requireValue(row&&!row.disabled,401,'登录已失效，请重新登录');
 requireValue(await passwordHash(password,row.salt)===row.password_hash,403,'当前密码不正确');
 return row;
}

async function replacePassword(env,actor,target,credentials,password,reset) {
 const salt=secret(),encoded=await passwordHash(password,salt);
 const guard=reset?"EXISTS(SELECT 1 FROM users actor WHERE actor.id=? AND actor.salt=? AND actor.password_hash=? AND actor.role='admin' AND actor.disabled=0)":'salt=? AND password_hash=? AND disabled=0';
 const values=reset?[actor.id,credentials.salt,credentials.password_hash]:[credentials.salt,credentials.password_hash];
 const committed='EXISTS(SELECT 1 FROM users WHERE id=? AND salt=? AND password_hash=?)';
 const results=await env.DB.batch([
  stmt(env,`UPDATE users SET salt=?,password_hash=? WHERE id=? AND ${guard} RETURNING id`,salt,encoded,target,...values),
  stmt(env,`DELETE FROM sessions WHERE user_id=? AND ${committed}`,target,target,salt,encoded),
  stmt(env,`INSERT INTO admin_audit(id,actor_id,target_id,action,details,created_at) SELECT ?,?,?,?,'{}',? WHERE ${committed}`,id(),actor.id,target,reset?'user.password.reset':'user.password.change',now(),target,salt,encoded),
 ]);
 requireValue(results[0].results.length===1,409,'账号凭据已变更，请刷新并重试');
}

export async function changePassword(env,user,body) {
 requireValue(Object.keys(body).every(k=>['current_password','new_password'].includes(k)),400,'未知密码设置');
 passwordValue(body.new_password);
 requireValue(body.new_password!==body.current_password,400,'新密码需与当前密码不同');
 const credentials=await verifiedCredentials(env,user,body.current_password);
 await replacePassword(env,user,user.id,credentials,body.new_password,false);
}

export async function resetPassword(env,user,target,body) {
 requireValue(user.role==='admin',403,'仅管理员可访问');
 requireValue(target!==user.id,400,'请在用户设置中修改自己的密码');
 requireValue(Object.keys(body).every(k=>k==='current_password'),400,'未知密码设置');
 const credentials=await verifiedCredentials(env,user,body.current_password);
 const exists=await stmt(env,'SELECT id FROM users WHERE id=?',target).first();
 requireValue(exists,404,'用户不存在');
 const password=secret().slice(0,32);
 await replacePassword(env,user,target,credentials,password,true);
 return password;
}
