// Local-only isolated admin database. Retains one fixture admin for browser verification.
import assert from 'node:assert/strict';
import {fastExecution} from './execution-fixture.mjs';
import {randomBytes} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const origin='http://127.0.0.1:8791',suffix=randomBytes(4).toString('hex');
const fixture=resolve('test-results/admin-ui-user.json'),channels=[],executors=[];
async function sql(command){const r=await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--persist-to','.wrangler/admin-state','--command',command],{windowsHide:true});return r.stdout;}
async function request(owner,path,{data,method=data?'POST':'GET',status=200,headers={}}={}) {
 const r=await fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(owner?{Cookie:owner.cookie}:{}),...headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,status,`${method} ${path}: ${r.status}`);return {r,body:await r.json()};
}
const api=async(owner,path,data,options={})=>(await request(owner,path,{data,...options})).body;
async function login(owner,status=200){const {r}=await request(null,'/api/auth/login',{data:{username:owner.username,password:owner.password},status});if(status===200)owner.cookie=r.headers.get('set-cookie').split(';')[0];return owner;}
async function register(label,extra={}){const u={username:label+'_'+suffix,password:randomBytes(24).toString('hex')};const {r,body}=await request(null,'/api/auth/register',{data:{...u,invite:'local-integration-invite-only',...extra}});u.id=body.user.id;u.cookie=r.headers.get('set-cookie').split(';')[0];await fastExecution(origin,u.cookie);return u;}
async function channel(owner){const c=await api(owner,'/api/channels',{title:'Admin quota fixture'},{status:201});channels.push([owner,c.id]);return c.id;}
async function machine(owner){const e=await api(owner,'/api/executors',{name:'Admin regression'},{status:201});executors.push([owner,e.id]);return e;}
const bearer=e=>({Authorization:`Bearer ${e.token}`,'X-Executor-Protocol':'2'});
const claim=async e=>(await api(null,'/api/executor/claim',{}, {headers:bearer(e)})).job;
const mutate=(root,target,b,options)=>api(root,`/api/admin/users/${target.id}`,{role:'user',disabled:false,storage_limit_bytes:null,monthly_transfer_limit_bytes:null,...b},options);
let root,bob,other;
try {
 try{root=JSON.parse(await readFile(fixture,'utf8'));await login(root);}catch(error){if(error.code!=='ENOENT')throw error;root=await register('admin_fixture');await sql(`UPDATE users SET role='admin' WHERE id='${root.id}'`);await writeFile(fixture,JSON.stringify(root));}
 await sql(`UPDATE users SET role='user' WHERE role='admin' AND id!='${root.id}'`);
 let overview=await api(root,'/api/admin/overview'),defaults={...overview.config,registration_enabled:true};delete defaults.id;
 await api(root,'/api/admin/config',defaults);
 bob=await register('ordinary',{role:'admin',storage_limit_bytes:999999999});
 assert.equal((await api(bob,'/api/dashboard')).user.role,'user','Registration cannot assign admin');
 await api(bob,'/api/admin/overview',undefined,{status:403});await api(bob,'/api/admin/config',defaults,{status:403});
 await request(root,'/api/admin/config',{data:defaults,status:403,headers:{Origin:'https://foreign.example'}});
 await mutate(root,root,{role:'user'},{status:409});await mutate(root,root,{role:'admin',disabled:true},{status:409});
 const created=await api(root,'/api/admin/users',{username:'created_'+suffix,role:'admin'});other={...created};await login(other);
 const concurrent=await Promise.all([root,other].map(target=>fetch(origin+`/api/admin/users/${target.id}`,{method:'POST',headers:{Origin:origin,Cookie:root.cookie,'Content-Type':'application/json'},body:JSON.stringify({role:'user',disabled:false,storage_limit_bytes:null,monthly_transfer_limit_bytes:null})})));
 assert.equal(concurrent.filter(r=>r.status===200).length,1,'Concurrent demotions must leave an enabled admin');
 const rootRole=(await api(root,'/api/dashboard')).user.role;
 if(rootRole!=='admin')await mutate(other,root,{role:'admin'});
 await mutate(root,other,{role:'user'});
 const listing=await api(root,'/api/admin/users');assert.ok(!JSON.stringify(listing).includes('password_hash'));assert.ok(!JSON.stringify(listing).includes('feed_token'));assert.ok(!JSON.stringify(listing).includes('salt'));
 const cid=await channel(bob),e=await machine(bob);
 await api(bob,`/api/channels/${cid}/sources`,{urls:['https://www.youtube.com/playlist?list=PLadminfixture123']},{status:201});
 const scan=await claim(e);await api(null,`/api/executor/jobs/${scan.id}/scan`,{entries:[{video_id:'adminvideo1',title:'First audio',duration:1},{video_id:'adminvideo2',title:'Second audio',duration:1}]},{headers:{...bearer(e),'X-Lease-Token':scan.leaseToken}});
 await mutate(root,bob,{storage_limit_bytes:20});
 const jobs=[await claim(e),await claim(e)],audio=Buffer.alloc(16,1);
 const upload=job=>fetch(origin+`/api/executor/jobs/${job.id}/audio`,{method:'POST',headers:{...bearer(e),'X-Lease-Token':job.leaseToken,'Content-Type':'audio/mpeg'},body:audio});
 const uploads=await Promise.all(jobs.map(upload));assert.deepEqual(uploads.map(r=>r.status).sort(),[200,409],'Atomic per-user storage cap');
 assert.equal((await api(bob,'/api/dashboard')).maxUserBytes,20);
 await api(bob,'/api/settings',{settings:{storage_limit_bytes:99999}},{status:400});
 await api(root,'/api/admin/config',{...defaults,max_storage_bytes:0});
 const pending=jobs[uploads.findIndex(r=>r.status===409)];assert.equal((await upload(pending)).status,409,'Global zero storage blocks new uploads');
 await api(root,'/api/admin/config',defaults);await mutate(root,bob,{storage_limit_bytes:40,monthly_transfer_limit_bytes:24});assert.equal((await upload(pending)).status,200);
 let dashboard=await api(bob,'/api/dashboard');const feedToken=dashboard.channels.find(c=>c.id===cid).feed_token,ep=dashboard.episodes.find(ep=>ep.channel_id===cid),media=`/media/${feedToken}/${ep.id}.mp3`;
 assert.equal(dashboard.bytes,32);
 const downloads=await Promise.all([1,2].map(()=>fetch(origin+media,{headers:{Range:'bytes=0-15'}})));assert.deepEqual(downloads.map(r=>r.status).sort(),[206,429],'Concurrent media requests cannot exceed monthly quota');
 assert.equal((await fetch(origin+media,{method:'HEAD'})).status,200);
 assert.equal((await fetch(origin+media,{headers:{Range:'bytes=0-7'}})).status,206);
 assert.equal((await fetch(origin+media,{headers:{Range:'bytes=0-0'}})).status,429);
 let users=(await api(root,'/api/admin/users')).users;assert.equal(users.find(u=>u.id===bob.id).transfer_bytes,24,'HEAD does not consume bytes');
 // Retained users from previous isolated runs may already have monthly usage.
 const globalLimit=(await api(root,'/api/admin/overview')).month.bytes+1;
 await mutate(root,bob,{storage_limit_bytes:40,monthly_transfer_limit_bytes:0});await api(root,'/api/admin/config',{...defaults,max_monthly_transfer_bytes:globalLimit});
 assert.equal((await fetch(origin+media,{headers:{Range:'bytes=0-0'}})).status,206);assert.equal((await fetch(origin+media,{headers:{Range:'bytes=0-0'}})).status,429,'Global monthly traffic cap');
 await sql(`DELETE FROM usage_daily WHERE user_id='${bob.id}'; INSERT INTO usage_daily(user_id,day,bytes,requests) VALUES('${bob.id}',date('now','start of month','-1 day'),25,4);`);
 assert.equal((await fetch(origin+media)).status,200,'Previous UTC month does not consume current quota');
 await api(bob,`/api/channels/${cid}/sources`,{urls:['https://www.youtube.com/watch?v=adminvideo3']},{status:201});const active=await claim(e);assert.ok(active);
 await mutate(root,bob,{disabled:true,storage_limit_bytes:40});
 assert.equal((await fetch(origin+`/subscribe/${feedToken}`)).status,404);
 await api(bob,'/api/dashboard',undefined,{status:401});await login(bob,403);assert.equal((await fetch(origin+`/feed/${feedToken}.xml`)).status,404);assert.equal((await fetch(origin+media)).status,404);
 await api(null,`/api/executor/jobs/${active.id}/heartbeat`,{}, {headers:{...bearer(e),'X-Lease-Token':active.leaseToken},status:401});
 await mutate(root,bob,{storage_limit_bytes:40});await login(bob);assert.equal((await fetch(origin+`/feed/${feedToken}.xml`)).status,200);
 await api(root,`/api/admin/users/${bob.id}/logout`,{});await api(bob,'/api/dashboard',undefined,{status:401});await api(null,'/api/executor/status',{}, {headers:bearer(e)});
 await api(root,'/api/admin/config',{...defaults,registration_enabled:false});
 await request(null,'/api/auth/register',{data:{username:'closed_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'},status:403});
 overview=await api(root,'/api/admin/overview');assert.ok(overview.audit.some(a=>a.action==='user.update'));assert.ok(!JSON.stringify(overview.audit).includes(created.password),'Audit must not contain generated passwords');
 await api(root,'/api/admin/config',defaults);
 console.log('PASS: admin isolation, last-admin/concurrent role safety, create/disable/logout, private feed and executor revocation, atomic storage/traffic caps, UTC monthly accounting, registration switch and audit privacy');
}finally{
 if(root?.cookie){try{const o=await api(root,'/api/admin/overview');const {id,...config}=o.config;await api(root,'/api/admin/config',{...config,max_storage_bytes:8000000000,default_user_storage_bytes:2000000000,default_monthly_transfer_bytes:0,max_monthly_transfer_bytes:0,registration_enabled:true});}catch{}}
 if(bob){try{await login(bob);}catch{}}
 for(const [u,eid]of executors)try{await api(u,`/api/executors/${eid}`,undefined,{method:'DELETE'});}catch{}
 for(const [u,cid]of channels)try{await api(u,`/api/channels/${cid}`,undefined,{method:'DELETE'});}catch{}
}
