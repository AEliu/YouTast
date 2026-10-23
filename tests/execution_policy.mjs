import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const origin='http://127.0.0.1:8791',suffix=randomBytes(4).toString('hex');
async function sql(command){await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--persist-to','.wrangler/admin-state','--command',command],{windowsHide:true});}
let cookie='',cid;const machines=[];
async function api(path,data,{status=200,headers={}}={}) {
 const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,status,`${path}: ${r.status}`);if(path==='/api/auth/register'&&r.ok)cookie=r.headers.get('set-cookie').split(';')[0];return r.json();
}
const auth=e=>({Authorization:'Bearer '+e.token,'X-Executor-Protocol':'2','X-Executor-Rate-Control':'1'});
const claim=e=>api('/api/executor/claim',{}, {headers:auth(e)});
const finish=(e,j)=>api(`/api/executor/jobs/${j.id}/scan`,{entries:[]},{headers:{...auth(e),'X-Lease-Token':j.leaseToken}});
try {
 await sql('DELETE FROM login_limits');
 const user=await api('/api/auth/register',{username:'throttle_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});
 const defaults=await api('/api/execution-policy');assert.equal(defaults.concurrency,1);assert.equal(defaults.start_interval,60);assert.equal(defaults.request_interval,2);assert.equal(defaults.download_wait,10);
 const config={concurrency:1,start_interval:60,request_interval:2,download_wait:10,cooldown_seconds:60,paused:false};
 cid=(await api('/api/channels',{title:'Execution control fixture'},{status:201})).id;
 await api(`/api/channels/${cid}/sources`,{urls:Array.from({length:8},(_,i)=>`https://www.youtube.com/watch?v=limit${i}abcde`)},{status:201});
 for(let i=0;i<2;i++)machines.push(await api('/api/executors',{name:'throttle machine '+i},{status:201}));
 const observer=machines[0];
 const statusFor=e=>api('/api/executor/status',{}, {headers:auth(e)});
 let status=await statusFor(observer);
 assert.deepEqual(Object.keys(status).sort(),['id','name','lastSeen','rateControlVersion','windowControlVersion','audioControlVersion','replayControlVersion','activeJobs','minimumProtocol'].sort());
 assert.equal(status.id,observer.id);assert.equal(status.name,'throttle machine 0');assert.equal(status.activeJobs,0);
 const beforeStatusSeen=status.lastSeen;
 assert.deepEqual(await statusFor(observer),status,'Inspection must not claim jobs or update last_seen');
 const first=await Promise.all(Array.from({length:6},(_,i)=>claim(machines[i%2])));assert.equal(first.filter(r=>r.job).length,1,'Shared default gate across machines');
 const accepted=first.findIndex(r=>r.job);let job=first[accepted].job,owner=machines[accepted%2];
 status=await statusFor(owner);assert.equal(status.activeJobs,1);assert.ok(status.lastSeen>=beforeStatusSeen);assert.equal(status.rateControlVersion,1);
 assert.equal((await statusFor(machines.find(e=>e.id!==owner.id))).activeJobs,0,'Status is scoped to the authenticated machine');
 assert.equal(job.options.execution.request_interval,2);await finish(owner,job);
 let denied=await claim(machines[1]);assert.equal(denied.job,null);assert.ok(denied.retryAfter>0,'Start interval survives completion');
 await api('/api/execution-policy',{...config,concurrency:2,start_interval:0});
 const second=await Promise.all([0,1,0,1].map(i=>claim(machines[i])));assert.equal(second.filter(r=>r.job).length,2,'Atomic shared concurrent cap');
 const active=second.map((r,i)=>r.job?{j:r.job,e:machines[i%2]}:null).filter(Boolean);
 await api('/api/execution-policy',{...config,concurrency:1,start_interval:0,paused:true});assert.equal((await claim(machines[0])).job,null);
 for(const item of active)await finish(item.e,item.j);
 assert.equal((await claim(machines[1])).job,null,'Pause persists after in-flight completion');
 await api('/api/execution-policy/resume',{});job=(await claim(machines[0])).job;assert.ok(job);
 await api(`/api/executor/jobs/${job.id}/fail`,{error:'YouTube requires verification; refresh this machine cookies'},{headers:{...auth(machines[0]),'X-Lease-Token':job.leaseToken}});
 denied=await claim(machines[1]);assert.equal(denied.job,null);assert.ok(denied.execution.cooldown_until>Date.now()/1000+40);
 const dashboard=await api('/api/dashboard');assert.ok(dashboard.executors.every(e=>e.rate_control_version===1));assert.ok(!dashboard.executors.some(e=>e.token_hash));
 await api('/api/execution-policy/resume',{});job=(await claim(machines[1])).job;assert.ok(job);await finish(machines[1],job);
 await api('/api/execution-policy',{...config,concurrency:4},{status:400});await api('/api/execution-policy',{...config,start_interval:-1},{status:400});await api('/api/execution-policy',{...config,request_interval:1.5},{status:400});await api('/api/execution-policy',{...config,user_id:'other'},{status:400});
 await api('/api/execution-policy',config,{headers:{Origin:'https://evil.example'},status:403});
 console.log('PASS: defaults, atomic per-user multi-machine concurrency/start gap, pause/drain/resume, verification cooldown, bounds/Origin isolation and capability reporting');
}finally{
 for(const e of machines)try{await fetch(origin+'/api/executors/'+e.id,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});}catch{}
 if(cid)await fetch(origin+'/api/channels/'+cid,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 await sql('DELETE FROM login_limits');
}
