// Actual local Wrangler/D1 API contract. Never use a production origin.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
import {fastExecution} from './execution-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8799',sql=localDatabase(origin,process.env.TEST_PERSIST_TO||'.wrangler/discovery-state');
const suffix=randomBytes(4).toString('hex'),accounts=[],channels=[];
let cookie='',executor,job;
const auth=()=>({'Authorization':'Bearer '+executor.token,'X-Executor-Protocol':'2','X-Executor-Rate-Control':'1','X-Executor-Content-Control':'1','X-Executor-Audio-Control':'1','X-Executor-Replay-Control':'1','X-Executor-Discovery-Control':'1'});
async function api(path,data={},headers={},status=200){const r=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':`2001:db8:${suffix.slice(0,4)}:${suffix.slice(4)}::1`,Cookie:cookie,...headers},body:JSON.stringify(data)});assert.equal(r.status,status,`${path}: ${r.status}`);return {body:await r.json(),r};}
const ids=Array.from({length:150},(_,i)=>'video'+String(i).padStart(6,'0'));
const inventory=async(values,lease=job.leaseToken,status=200)=>(await api(`/api/executor/jobs/${job.id}/inventory`,{items:values.map((id,i)=>({id,position:i+1}))},{...auth(),'X-Lease-Token':lease},status)).body;
const collect=async(selected,status=200)=>(await api(`/api/executor/jobs/${job.id}/scan`,{entries:selected.map(e=>({video_id:e.id,position:e.position,title:e.id,duration:10})),recurring:true},{...auth(),'X-Lease-Token':job.leaseToken},status)).body;
const claim=async()=>{job=(await api('/api/executor/claim',{},auth())).body.job;assert.equal(job?.kind,'scan');return job;};
try{
 const registered=await api('/api/auth/register',{username:'discovery_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});accounts.push(registered.body.user);cookie=registered.r.headers.get('set-cookie').split(';')[0];
 await fastExecution(origin,cookie);executor=(await api('/api/executors',{name:'Discovery fixture'},{},201)).body;
 const channel=(await api('/api/channels',{title:'Discovery fixture'},{},201)).body.id;channels.push(channel);
 await api(`/api/channels/${channel}/sources`,{urls:['https://www.youtube.com/playlist?list=PLdiscoveryfixture']},{},201);
 assert.equal((await api('/api/executor/claim',{}, {...auth(),'X-Executor-Discovery-Control':'0'})).body.job,null);
 await claim();await collect([],409);
 let batch=await inventory(ids);assert.equal(batch.selected.length,30);await collect(batch.selected);
 let rows=await sql(`SELECT COUNT(*) n FROM episodes WHERE channel_id='${channel}'`);assert.equal(rows[0].results[0].n,30);
 const sync=async()=>{await sql(`UPDATE jobs SET status='done' WHERE user_id='${accounts[0].id}' AND kind='transcode'`);await api(`/api/channels/${channel}/sync`);await claim();};
 await sync();const updated=['newhead0001',...ids.slice(0,75),'newmid00001',...ids.slice(75),'newtail0001'];
 batch=await inventory(updated);assert.deepEqual(batch.selected.map(e=>e.id),['newhead0001','newmid00001','newtail0001']);
 const oldLease=job.leaseToken;await sql(`UPDATE jobs SET status='queued',lease_token=NULL,executor_id=NULL,available_at=0 WHERE id='${job.id}'`);await claim();await inventory(updated,oldLease,409);
 const resumed=await inventory(updated);assert.deepEqual(resumed.selected,batch.selected);await collect(resumed.selected);
 await sync();const burst=Array.from({length:65},(_,i)=>'burst'+String(i).padStart(6,'0'));
 for(const size of [30,30,5]){batch=await inventory([...updated,...burst]);assert.equal(batch.selected.length,size);assert.equal(batch.has_more,size!==5);await collect(batch.selected);await sync();}
 batch=await inventory([...ids,...burst].reverse());assert.equal(batch.selected.length,0);await collect([]);
 rows=await sql(`SELECT COUNT(*) n FROM episodes WHERE channel_id='${channel}'`);assert.equal(rows[0].results[0].n,98);
 // An older executor may still scan an author after playlist scans are done.
 const author=(await api('/api/channels',{title:'Author compatibility'},{},201)).body.id;channels.push(author);
 await sql(`UPDATE jobs SET status='done' WHERE user_id='${accounts[0].id}' AND kind='transcode'`);
 await api(`/api/channels/${author}/sources`,{urls:['https://www.youtube.com/@fixture/videos']},{},201);
 job=(await api('/api/executor/claim',{}, {...auth(),'X-Executor-Discovery-Control':'0'})).body.job;assert.equal(job.source.kind,'author');
 await inventory(ids,job.leaseToken,409);
 await api(`/api/executor/jobs/${job.id}/scan`,{entries:[],recurring:true},{...auth(),'X-Lease-Token':job.leaseToken,'X-Executor-Discovery-Control':'0'});
 const large=(await api('/api/channels',{title:'Inventory boundary'},{},201)).body.id;channels.push(large);
 await api(`/api/channels/${large}/sources`,{urls:['https://www.youtube.com/playlist?list=PLboundaryfixture']},{},201);await claim();
 const many=Array.from({length:10001},(_,i)=>'large'+String(i).padStart(6,'0'));
 await inventory(many,job.leaseToken,400);
 batch=await inventory(many.slice(0,10000));assert.equal(batch.selected.length,30);
 // Claim replies intentionally expose URL/kind rather than internal source IDs.
 assert.equal((await sql(`SELECT COUNT(*) n FROM source_discoveries d JOIN sources s ON s.id=d.source_id WHERE s.channel_id='${large}'`))[0].results[0].n,10000);
 await collect(batch.selected);
 console.log('PASS: real local D1 inventory baseline, middle/tail additions, durable retries, 30/30/5 batches, reorder/removal preservation, old-executor playlist gate and unchanged author scans');
}finally{await cleanupLocalUsers({origin,sql,accounts});}
