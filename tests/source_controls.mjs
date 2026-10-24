import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
import {fastExecution} from './execution-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8800',sql=localDatabase(origin,process.env.TEST_PERSIST_TO||'.wrangler/source-controls-state');
const suffix=randomBytes(4).toString('hex'),accounts=[];
let cookie='',machine,channel;
async function api(path,data,options={}){const response=await fetch(origin+path,{method:options.method||(data?'POST':'GET'),headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':`2001:db8:${suffix.slice(0,4)}:${suffix.slice(4)}::1`,Cookie:options.cookie??cookie,...options.headers},body:data?JSON.stringify(data):undefined});assert.equal(response.status,options.status||200,`${path}: ${response.status}`);return {body:await response.json(),response};}
const auth=()=>({'Authorization':'Bearer '+machine.token,'X-Executor-Protocol':'2','X-Executor-Rate-Control':'1','X-Executor-Content-Control':'1','X-Executor-Audio-Control':'1','X-Executor-Replay-Control':'1','X-Executor-Discovery-Control':'1'});
const claim=async()=> (await api('/api/executor/claim',{}, {headers:auth()})).body.job;
const detail=async()=> (await api(`/api/channels/${channel}/detail?tab=episodes`)).body;
const settings=(source,data,options={})=>api(`/api/channels/${channel}/sources/${source.id}`,data,options);
const scan=async(job,entries)=>api(`/api/executor/jobs/${job.id}/scan`,{entries,recurring:true},{headers:{...auth(),'X-Lease-Token':job.leaseToken}});
try{
 const registered=await api('/api/auth/register',{username:'source_controls_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});accounts.push(registered.body.user);cookie=registered.response.headers.get('set-cookie').split(';')[0];
 await fastExecution(origin,cookie);machine=(await api('/api/executors',{name:'Source controls fixture'},{status:201})).body;
 channel=(await api('/api/channels',{title:'Independent source windows'},{status:201})).body.id;
 await api(`/api/channels/${channel}/sources`,{urls:['https://www.youtube.com/@sourceA/videos','https://www.youtube.com/@sourceB/videos']},{status:201});
 const upload=async job=>{const r=await fetch(origin+`/api/executor/jobs/${job.id}/audio`,{method:'POST',headers:{...auth(),'X-Lease-Token':job.leaseToken,'Content-Type':'audio/mpeg','X-Audio-Duration':'1'},body:Buffer.alloc(16,73)});assert.equal(r.status,200);};
 let scanned=0,uploaded=0;
 while(scanned<2){const job=await claim();assert.ok(job);if(job.kind==='transcode'){await upload(job);uploaded++;continue;}const prefix=job.source.url.includes('sourceA')?'a':'b';await scan(job,Array.from({length:5},(_,i)=>({video_id:prefix+'video'+String(i).padStart(5,'0'),title:prefix+i,duration:1,position:i+1,published_at:1700000000+(prefix==='b'?100:0)+i})));scanned++;}
 while(uploaded<10){const job=await claim();assert.equal(job.kind,'transcode');await upload(job);uploaded++;}
 let model=await detail();const [a,b]=['sourceA','sourceB'].map(name=>model.sources.find(s=>s.url.includes(name)));
 await settings(a,{latest_limit:2});await settings(b,{latest_limit:3});model=await detail();assert.equal(model.page.total,5);assert.equal(model.counts.archived,5);
 const feed=(await api('/api/dashboard')).body.channels.find(c=>c.id===channel).feed_token;
 assert.equal(((await (await fetch(origin+'/feed/'+feed+'.xml')).text()).match(/<item>/g)||[]).length,5);
 await settings(a,{latest_limit:4});model=await detail();assert.equal(model.page.total,7);assert.equal(model.counts.archived,3);assert.equal((await api('/api/dashboard')).body.bytes,160);
 await api(`/api/channels/${channel}/settings`,{title:'Independent source windows',description:'',settings:{latest_limit:4},rss_metadata:{author:'',image:'',language:'inherit',category:'Education',explicit:false}});assert.equal((await detail()).page.total,4);
 await api(`/api/channels/${channel}/settings`,{title:'Independent source windows',description:'',settings:{latest_limit:0},rss_metadata:{author:'',image:'',language:'inherit',category:'Education',explicit:false}});
 await sql(`UPDATE sources SET next_scan=0 WHERE id='${b.id}'`);
 await api(`/api/channels/${channel}/sources/${a.id}/sync`,{});assert.equal((await sql(`SELECT COUNT(*) n FROM jobs WHERE source_id='${b.id}' AND status='queued'`))[0].results[0].n,0,'Single-source sync must not enqueue another due source');assert.equal((await api('/api/executor/claim',{}, {headers:{...auth(),'X-Executor-Content-Control':'0'}})).body.job,null,'Older executors must not ignore source-specific window sizes');let job=await claim();assert.equal(job.source.url,a.url);
 await settings(a,{paused:true});await api(`/api/executor/jobs/${job.id}/scan`,{entries:[]},{headers:{...auth(),'X-Lease-Token':job.leaseToken},status:409});
 await api(`/api/channels/${channel}/sources/${a.id}/sync`,{},{status:409});assert.equal((await detail()).page.total,7);
 await settings(a,{paused:false});job=await claim();assert.equal(job.source.url,a.url);await scan(job,[]);
 for(const bad of [{latest_limit:-1},{latest_limit:101},{latest_limit:2.5},{latest_limit:'2'},{paused:1},{role:'admin'}])await settings(a,bad,{status:400});
 const stranger=await api('/api/auth/register',{username:'source_stranger_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});accounts.push(stranger.body.user);const strangerCookie=stranger.response.headers.get('set-cookie').split(';')[0];await settings(a,{latest_limit:1},{cookie:strangerCookie,status:404});
 console.log('PASS: independent 2/3 RSS windows, cached audio retention/reuse, channel total, per-source sync, pause lease revocation/resume, strict validation and owner isolation');
}finally{await cleanupLocalUsers({origin,sql,accounts});}
