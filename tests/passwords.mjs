import {fetchWithDiscovery as fetch} from './discovery-fixture.mjs';
// Local security contract. A reusable fixture admin is retained intentionally.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8794';
const state=process.env.TEST_PERSIST_TO||'.wrangler/password-state',sql=localDatabase(origin,state);
const tag=createHash('sha256').update(resolve(state)).digest('hex').slice(0,8);
const fixture=`test-results/password-admin-${tag}.json`,accounts=[],suffix=randomBytes(5).toString('hex');
const ipPrefix=`2001:db8:${suffix.slice(0,4)}:${suffix.slice(4,8)}::`;
let root,owner,other,channel;
async function api(path,data,{actor,status=200,method=data?'POST':'GET',ip='192.0.2.101',headers={}}={}){
 const localIp=ipPrefix+ip.split('.').at(-1);
 const r=await fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':localIp,...(actor?{Cookie:actor.cookie}:{}),...headers},body:data?JSON.stringify(data):undefined});
 assert.ok((Array.isArray(status)?status:[status]).includes(r.status),`${path}: ${r.status}`);
 return {r,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
async function register(label){
 const user={username:label+'_'+suffix,password:randomBytes(24).toString('hex')};
 const response=await api('/api/auth/register',{...user,invite:'local-integration-invite-only'});
 const account={...user,id:response.body.user.id,cookie:response.cookie};accounts.push({id:account.id,username:account.username});return account;
}
async function login(actor,password=actor.password,status=200,ip='192.0.2.102'){
 return api('/api/auth/login',{username:actor.username,password},{status,ip});
}
try{
 await mkdir('test-results',{recursive:true});
 try{root=JSON.parse(await readFile(fixture,'utf8'));root.cookie=(await login(root)).cookie;}
 catch(error){
  if(error.code!=='ENOENT')throw error;
  root=await register('password_admin');
  await sql(`UPDATE users SET role='admin' WHERE id='${root.id}'`);
  accounts.splice(accounts.findIndex(a=>a.id===root.id),1);
  await writeFile(fixture,JSON.stringify({id:root.id,username:root.username,password:root.password}));
 }
 owner=await register('password_owner');other=await register('password_other');
 channel=(await api('/api/channels',{title:'Password contract'},{actor:owner,status:201})).body.id;
 const token=(await api('/api/executors',{name:'Password contract'},{actor:owner,status:201})).body.token;
 const feed=(await api('/api/dashboard',undefined,{actor:owner})).body.channels.find(c=>c.id===channel).feed_token;
 const second={...owner,cookie:(await login(owner)).cookie};
 const old=owner.password,next=randomBytes(24).toString('hex');
 await api('/api/auth/password',{current_password:'wrong-password-value',new_password:next},{actor:owner,status:403});
 await api('/api/auth/password',{current_password:old,new_password:'short'},{actor:owner,status:400});
 await api('/api/auth/password',{current_password:old,new_password:old},{actor:owner,status:400});
 await api('/api/auth/password',{current_password:old,new_password:next,user_id:other.id},{actor:owner,status:400});
 await api('/api/auth/password',{current_password:old,new_password:next},{actor:owner,headers:{Origin:'https://evil.example'},status:403});
 await api('/api/me',undefined,{actor:second});
 const [changed,oldLogin]=await Promise.all([
  api('/api/auth/password',{current_password:old,new_password:next},{actor:owner,ip:'192.0.2.103'}),
  login(owner,old,[200,401],'192.0.2.104'),
 ]);
 assert.match(changed.r.headers.get('set-cookie'),/Max-Age=0/);
 for(const actor of [owner,second,...(oldLogin.r.status===200?[{cookie:oldLogin.cookie}]:[])])await api('/api/me',undefined,{actor,status:401});
 await login(owner,old,401);owner.password=next;owner.cookie=(await login(owner)).cookie;
 assert.equal((await fetch(origin+'/feed/'+feed+'.xml')).status,200,'Password change must preserve RSS access');
 await api('/api/executor/status',{}, {headers:{Authorization:'Bearer '+token}});
 await api('/api/admin/users/'+other.id+'/password',{current_password:next},{actor:owner,status:403});
 await api('/api/admin/users/'+root.id+'/password',{current_password:root.password},{actor:root,status:400});
 await api('/api/admin/users/'+owner.id+'/password',{current_password:'wrong-admin-password'},{actor:root,status:403});
 await api('/api/me',undefined,{actor:owner});
 const update={role:'user',disabled:true,storage_limit_bytes:null,monthly_transfer_limit_bytes:null};
 await api('/api/admin/users/'+owner.id,update,{actor:root});
 const reset=(await api('/api/admin/users/'+owner.id+'/password',{current_password:root.password},{actor:root})).body.password;
 assert.match(reset,/^[a-f0-9]{32}$/);
 await login(owner,reset,403);await login(owner,next,401);
 await api('/api/admin/users/'+owner.id,{...update,disabled:false},{actor:root});
 owner.password=reset;owner.cookie=(await login(owner)).cookie;
 assert.equal((await fetch(origin+'/feed/'+feed+'.xml')).status,200);
 const audit=(await api('/api/admin/overview',undefined,{actor:root})).body.audit;
 assert.ok(audit.some(a=>a.action==='user.password.change'));assert.ok(audit.some(a=>a.action==='user.password.reset'));
 for(const secret of [old,next,reset,root.password])assert.ok(!JSON.stringify(audit).includes(secret),'Audit must not store passwords');
 for(let i=0;i<15;i++)await api('/api/auth/password',{current_password:'wrong-password-attempt',new_password:next},{actor:other,ip:'192.0.2.213',status:403});
 await api('/api/auth/password',{current_password:'wrong-password-attempt',new_password:next},{actor:other,ip:'192.0.2.213',status:429});
 const candidates=[randomBytes(24).toString('hex'),randomBytes(24).toString('hex')];
 const competing=await Promise.all(candidates.map(new_password=>api('/api/auth/password',{current_password:other.password,new_password},{actor:other,ip:'192.0.2.214',status:[200,401,409]})));
 assert.equal(competing.filter(r=>r.r.status===200).length,1,'Only one concurrent password change may win');
 other.password=candidates[competing.findIndex(r=>r.r.status===200)];other.cookie=(await login(other)).cookie;
 console.log('PASS: password change/reset, session and racing-login revocation, disabled account preservation, admin reauthentication, Origin/role/bounds/rate limits, concurrent CAS and redacted audit; reusable fixture admin retained');
}finally{
 try{
  if(channel&&owner?.cookie)await fetch(origin+'/api/channels/'+channel,{method:'DELETE',headers:{Origin:origin,Cookie:owner.cookie}});
 }finally{await cleanupLocalUsers({origin,sql,accounts});}
}
