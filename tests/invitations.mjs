// Isolated local DB only; never run against production.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8791',suffix=randomBytes(4).toString('hex');
const state=process.env.TEST_PERSIST_TO||'.wrangler/admin-state',database=localDatabase(origin,state),accounts=[];
let requestNumber=0;
const localIp=()=>`2001:db8:${suffix.slice(0,4)}:${suffix.slice(4)}::${(++requestNumber).toString(16)}`;
const root=JSON.parse(await readFile(process.env.TEST_ADMIN_FIXTURE||'test-results/admin-ui-user.json','utf8'));
async function sql(command){return JSON.stringify(await database(command));}
async function request(path,{data,cookie=root.cookie,status=200,headers={}}={}) {
 const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':localIp(),...(cookie?{Cookie:cookie}:{}),...headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,status,`${path}: ${r.status}`);return {r,body:await r.json()};
}
const api=async(path,data,options={})=>(await request(path,{data,...options})).body;
const fresh=()=>({label:'Invite test '+suffix,max_uses:1,expires_at:null});
let serial=0,legacy,originalLegacy;
async function register(code,extra={},status=200){const result=await request('/api/auth/register',{cookie:null,data:{username:'invite_'+suffix+'_'+(++serial),password:randomBytes(20).toString('hex'),invite:code,...extra},status});if(status===200)accounts.push(result.body.user);return result;}
try {
 const login=await request('/api/auth/login',{cookie:null,data:{username:root.username,password:root.password}});root.cookie=login.r.headers.get('set-cookie').split(';')[0];
 let list=await api('/api/admin/invitations');legacy=list.invitations.find(i=>i.legacy);assert.ok(legacy);originalLegacy={label:legacy.label,max_uses:legacy.max_uses,expires_at:legacy.expires_at,enabled:!!legacy.enabled};
 const code=await api('/api/admin/invitations',{...fresh(),max_uses:2});assert.match(code.code,/^YT-[a-f0-9]{32}$/);
 const outputs=await Promise.all(Array.from({length:6},()=>fetch(origin+'/api/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':localIp()},body:JSON.stringify({username:'race_'+suffix+'_'+(++serial),password:randomBytes(20).toString('hex'),invite:code.code,role:'admin'})})));
 for(const response of outputs)if(response.status===200)accounts.push((await response.clone().json()).user);
 assert.deepEqual(outputs.map(r=>r.status).sort(),[200,200,403,403,403,403]);
 list=await api('/api/admin/invitations');let item=list.invitations.find(i=>i.id===code.id);assert.equal(item.used_count,2);assert.equal(item.max_uses,2);
 assert.ok(!JSON.stringify(list).includes('code_hash'));assert.ok(!JSON.stringify(list).includes(code.code));
 const digest=createHash('sha256').update(code.code).digest('hex');assert.ok((await sql(`SELECT code_hash FROM invitations WHERE id='${code.id}'`)).includes(digest));
 const users=(await api('/api/admin/users?search=race_'+suffix)).users;assert.equal(users.length,2);assert.ok(users.every(u=>u.role==='user'));
 await api('/api/admin/invitations/'+code.id,{...fresh(),enabled:true,max_uses:1},{status:409});
 await api('/api/admin/invitations/'+code.id,{...fresh(),enabled:true,max_uses:3});await register(code.code);
 const duplicate=await api('/api/admin/invitations',fresh());await register(duplicate.code,{username:root.username},409);
 item=(await api('/api/admin/invitations')).invitations.find(i=>i.id===duplicate.id);assert.equal(item.used_count,0,'Failed username insert must roll back consumption');
 await register(duplicate.code,{password:'short'},400);item=(await api('/api/admin/invitations')).invitations.find(i=>i.id===duplicate.id);assert.equal(item.used_count,0);
 const disabled=await api('/api/admin/invitations',fresh());await api('/api/admin/invitations/'+disabled.id,{...fresh(),enabled:false});await register(disabled.code,{},403);
 await api('/api/admin/invitations/'+disabled.id,{...fresh(),enabled:true});const ordinary=await register(disabled.code);
 const ordinaryCookie=ordinary.r.headers.get('set-cookie').split(';')[0];await api('/api/admin/invitations',undefined,{cookie:ordinaryCookie,status:403});await api('/api/admin/invitations',fresh(),{cookie:ordinaryCookie,status:403});
 const expired=await api('/api/admin/invitations',fresh());await api('/api/admin/invitations/'+expired.id,{...fresh(),enabled:true,expires_at:Math.floor(Date.now()/1000)-60});await register(expired.code,{},403);
 const unlimited=await api('/api/admin/invitations',{...fresh(),max_uses:0});for(let i=0;i<3;i++)await register(unlimited.code);
 item=(await api('/api/admin/invitations')).invitations.find(i=>i.id===unlimited.id);assert.equal(item.used_count,3);assert.equal(item.max_uses,0);
 await api('/api/admin/invitations/'+legacy.id,{...originalLegacy,enabled:false});await register('local-integration-invite-only',{},403);
 item=(await api('/api/admin/invitations')).invitations.find(i=>i.id===legacy.id);assert.equal(item.enabled,0,'Legacy import must not re-enable a disabled code');
 await api('/api/admin/invitations',{...fresh(),max_uses:-1},{status:400});await api('/api/admin/invitations',{...fresh(),expires_at:1},{status:400});
 await api('/api/admin/invitations',fresh(),{headers:{Origin:'https://evil.example'},status:403});
 const audit=(await api('/api/admin/overview')).audit;assert.ok(audit.some(a=>a.action==='invite.create'));assert.ok(audit.some(a=>a.action==='invite.update'));assert.ok(!JSON.stringify(audit).includes(code.code));
 await writeFile('test-results/invitation-ui-fixture.json',JSON.stringify({id:code.id,label:'Invite test '+suffix}));
 console.log('PASS: atomic invitation redemption, failed registration rollback, caps/top-up/unlimited, expiration/disable, legacy import, ordinary-user/Origin isolation, hash-only storage and redacted audit');
}finally{
 try{if(legacy&&originalLegacy)await api('/api/admin/invitations/'+legacy.id,originalLegacy);}
 finally{await cleanupLocalUsers({origin,sql:database,accounts});}
}
