import {fetchWithDiscovery as fetch} from './discovery-fixture.mjs';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8791',suffix=randomBytes(4).toString('hex');
const accounts=[],sql=localDatabase(origin,process.env.TEST_PERSIST_TO||'.wrangler/admin-state');
let cookie='',cid;const machines=[];
async function api(path,data,{status=200,headers={}}={}) {
 const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,status,`${path}: ${r.status}`);if(path==='/api/auth/register'&&r.ok)cookie=r.headers.get('set-cookie').split(';')[0];return r.json();
}
const auth=e=>({Authorization:'Bearer '+e.token,'X-Executor-Protocol':'2','X-Executor-Rate-Control':'1'});
const claim=e=>api('/api/executor/claim',{}, {headers:auth(e)});
const finish=(e,j)=>api(`/api/executor/jobs/${j.id}/scan`,{entries:[]},{headers:{...auth(e),'X-Lease-Token':j.leaseToken}});
try {
 const user=await api('/api/auth/register',{username:'throttle_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});
 accounts.push({id:user.user.id,username:'throttle_'+suffix});
 const defaults=await api('/api/execution-policy');assert.equal(defaults.concurrency,1);assert.equal(defaults.start_interval,60);assert.equal(defaults.request_interval,2);assert.equal(defaults.download_wait,10);
 assert.equal(defaults.scan_concurrency,1);assert.equal(defaults.scan_start_interval,15);
 const config={concurrency:1,start_interval:60,scan_concurrency:1,scan_start_interval:0,request_interval:2,download_wait:10,cooldown_seconds:60,paused:false};
 cid=(await api('/api/channels',{title:'Execution control fixture'},{status:201})).id;
 await api(`/api/channels/${cid}/sources`,{urls:Array.from({length:8},(_,i)=>`https://www.youtube.com/watch?v=limit${i}abcde`)},{status:201});
 for(let i=0;i<2;i++)machines.push(await api('/api/executors',{name:'throttle machine '+i},{status:201}));
 const observer=machines[0];
 const statusFor=e=>api('/api/executor/status',{}, {headers:auth(e)});
 let status=await statusFor(observer);
 assert.deepEqual(Object.keys(status).sort(),['id','name','lastSeen','rateControlVersion','windowControlVersion','audioControlVersion','replayControlVersion','discoveryControlVersion','activeJobs','minimumProtocol','paused'].sort());
 assert.equal(status.id,observer.id);assert.equal(status.name,'throttle machine 0');assert.equal(status.activeJobs,0);assert.equal(status.paused,false);
 const beforeStatusSeen=status.lastSeen;
 assert.deepEqual(await statusFor(observer),status,'Inspection must not claim jobs or update last_seen');
 const first=await Promise.all(Array.from({length:6},(_,i)=>claim(machines[i%2])));assert.equal(first.filter(r=>r.job).length,1,'Shared default gate across machines');
 const accepted=first.findIndex(r=>r.job);let job=first[accepted].job,owner=machines[accepted%2];
 status=await statusFor(owner);assert.equal(status.activeJobs,1);assert.ok(status.lastSeen>=beforeStatusSeen);assert.equal(status.rateControlVersion,1);
 assert.equal((await statusFor(machines.find(e=>e.id!==owner.id))).activeJobs,0,'Status is scoped to the authenticated machine');
 assert.equal(job.options.execution.request_interval,2);await finish(owner,job);
 let denied=await claim(machines[1]);assert.equal(denied.job,null);assert.ok(denied.retryAfter>0,'Start interval survives completion');
 assert.equal(denied.retryReason,'start_interval','A known start delay is distinguishable from an empty queue');
 await api('/api/execution-policy',{...config,scan_concurrency:2,start_interval:0});
 const second=await Promise.all([0,1,0,1].map(i=>claim(machines[i])));assert.equal(second.filter(r=>r.job).length,2,'Atomic shared concurrent cap');
 const active=second.map((r,i)=>r.job?{j:r.job,e:machines[i%2]}:null).filter(Boolean);
 await api('/api/execution-policy',{...config,concurrency:1,start_interval:0,paused:true});assert.equal((await claim(machines[0])).job,null);
 for(const item of active)await finish(item.e,item.j);
 assert.equal((await claim(machines[1])).job,null,'Pause persists after in-flight completion');
 await api('/api/execution-policy/resume',{});job=(await claim(machines[0])).job;assert.ok(job);
 await api(`/api/executor/jobs/${job.id}/fail`,{error:'YouTube requires verification; refresh this machine cookies'},{headers:{...auth(machines[0]),'X-Lease-Token':job.leaseToken}});
 denied=await claim(machines[1]);assert.equal(denied.job,null);assert.ok(denied.execution.cooldown_until>Date.now()/1000+40);
 assert.equal(denied.retryReason,undefined,'Cooldown still checks for an operator resume');
 const dashboard=await api('/api/dashboard');assert.ok(dashboard.executors.every(e=>e.rate_control_version===1));assert.ok(!dashboard.executors.some(e=>e.token_hash));
 await api('/api/execution-policy/resume',{});job=(await claim(machines[1])).job;assert.ok(job);await finish(machines[1],job);
 const [firstMachine,secondMachine]=machines;
 const machineRoute=`/api/executors/${firstMachine.id}`;
 await api('/api/execution-policy',{...config,scan_concurrency:2,start_interval:0});
 const inFlight=(await claim(firstMachine)).job;assert.ok(inFlight);
 assert.deepEqual(await api(machineRoute,{paused:true}),{ok:true,paused:true});
 assert.equal((await api(machineRoute,{paused:true})).paused,true,'Pause is idempotent');
 const [pausedClaim,otherClaim]=await Promise.all(machines.map(claim));
 assert.equal(pausedClaim.job,null);assert.equal(pausedClaim.executorPaused,true);assert.equal(pausedClaim.execution.paused,true);
 assert.ok(otherClaim.job,'The other machine continues taking work');
 assert.equal((await statusFor(firstMachine)).activeJobs,1,'Pausing preserves the existing lease');
 assert.equal((await statusFor(firstMachine)).paused,true);
 const machineStates=new Map((await api('/api/dashboard')).executors.map(e=>[e.id,e.paused]));
 assert.equal(machineStates.get(firstMachine.id),true);assert.equal(machineStates.get(secondMachine.id),false);
 assert.equal((await api('/api/execution-policy')).paused,false,'A machine pause is independent of account policy');
 await api(machineRoute,{paused:'false'},{status:400});
 await api(machineRoute,{paused:false,token:'other'},{status:400});
 await api(machineRoute,{paused:false},{headers:{Origin:'https://evil.example'},status:403});
 await api(machineRoute,{paused:false},{headers:{...auth(firstMachine),Cookie:''},status:401});
 const ownerCookie=cookie;
 const strangerName='pause_stranger_'+suffix;
 const stranger=await api('/api/auth/register',{username:strangerName,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});
 accounts.push({id:stranger.user.id,username:strangerName});
 try{await api(machineRoute,{paused:false},{status:404});}finally{cookie=ownerCookie;}
 await api(`/api/executor/jobs/${inFlight.id}/heartbeat`,{}, {headers:{...auth(firstMachine),'X-Lease-Token':inFlight.leaseToken}});
 await finish(firstMachine,inFlight);await finish(secondMachine,otherClaim.job);
 await api('/api/execution-policy',{...config,start_interval:0,paused:true});
 assert.equal((await claim(secondMachine)).job,null);
 await api('/api/execution-policy/resume',{});
 assert.equal((await claim(firstMachine)).executorPaused,true,'Account resume preserves the machine pause');
 assert.deepEqual(await api(machineRoute,{paused:false}),{ok:true,paused:false});
 job=(await claim(firstMachine)).job;assert.ok(job,'The original key can claim again after resuming');
 await finish(firstMachine,job);
 assert.equal((await statusFor(firstMachine)).paused,false);
 await api('/api/execution-policy',config);
 await api(`/api/channels/${cid}/sources`,{urls:['https://www.youtube.com/watch?v=split1abcde','https://www.youtube.com/watch?v=split2abcde','https://www.youtube.com/watch?v=split3abcde']},{status:201});
 const seed=(await claim(firstMachine)).job;
 assert.equal(seed.kind,'scan');
 await api(`/api/executor/jobs/${seed.id}/scan`,{entries:[{video_id:new URL(seed.source.url).searchParams.get('v'),title:'Independent audio',duration:30}]},
  {headers:{...auth(firstMachine),'X-Lease-Token':seed.leaseToken}});
 await api('/api/execution-policy',{...config,scan_start_interval:15});
 const audioAuth={...auth(secondMachine),'X-Executor-Audio-Control':'1'};
 const audio=(await api('/api/executor/claim',{}, {headers:audioAuth})).job;
 assert.equal(audio.kind,'transcode','Audio can claim during the scan startup delay');
 const waiting=await claim(firstMachine);assert.equal(waiting.job,null);assert.equal(waiting.retryReason,'start_interval');
 await sql(`UPDATE execution_policy SET scan_next_start_at=0 WHERE user_id='${user.user.id}'`);
 const scans=await Promise.all([firstMachine,secondMachine].map(claim));
 assert.equal(scans.filter(r=>r.job?.kind==='scan').length,1,'A real audio lease does not block one scan, and the scan cap is atomic');
 await api('/api/execution-policy',{...config,concurrency:4},{status:400});await api('/api/execution-policy',{...config,start_interval:-1},{status:400});await api('/api/execution-policy',{...config,request_interval:1.5},{status:400});await api('/api/execution-policy',{...config,user_id:'other'},{status:400});
 await api('/api/execution-policy',config,{headers:{Origin:'https://evil.example'},status:403});
 console.log('PASS: separate queue limits and start spacing, parallel scan/audio, account and machine pauses, stable leases, and isolation');
}finally{
 try{
 for(const e of machines)try{await fetch(origin+'/api/executors/'+e.id,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});}catch{}
 if(cid)await fetch(origin+'/api/channels/'+cid,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});

 }finally{await cleanupLocalUsers({origin,sql,accounts});}
}
