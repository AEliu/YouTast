// Local-only source lifecycle: empty live scans must reappear via cron, not fail.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
const origin='http://127.0.0.1:8787',suffix=randomBytes(4).toString('hex');
let cookie='',machine,cid;
async function sql(command){await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--command',command],{windowsHide:true});}
async function api(path,data,headers={},status=200){
 const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,status,`${path}: ${r.status}`);return {r,body:await r.json()};
}
const auth=(modern=true)=>({Authorization:'Bearer '+machine.token,'X-Executor-Protocol':'2','X-Executor-Audio-Control':'1',...(modern?{'X-Executor-Replay-Control':'1'}:{})});
const claim=async(modern=true)=>(await api('/api/executor/claim',{},auth(modern))).body.job;
const scan=(j,entries)=>api(`/api/executor/jobs/${j.id}/scan`,{entries},{...auth(),'X-Lease-Token':j.leaseToken});
const dash=async()=>(await api('/api/dashboard')).body;
const entry={video_id:'replay00001',title:'Processed live replay',duration:20,published_at:1700000000,metadata:{text_language:'zh-CN',complete:true}};
try{
 const registered=await api('/api/auth/register',{username:'replays_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});cookie=registered.r.headers.get('set-cookie').split(';')[0];
 await api('/api/execution-policy',{concurrency:3,start_interval:0,request_interval:0,download_wait:0,cooldown_seconds:60,paused:false});
 cid=(await api('/api/channels',{title:'Live lifecycle'},{},201)).body.id;
 machine=(await api('/api/executors',{name:'replay fixture'},{},201)).body;
 await api(`/api/channels/${cid}/sources`,{urls:['https://www.youtube.com/live/replay00001']},{},201);
 let job=await claim();await scan(job,[]);
 let d=await dash(),single=d.sources.find(s=>s.channel_id===cid);
 assert.equal(single.waiting_replay,1);assert.ok(single.next_scan>Date.now()/1000+3500&&single.next_scan<Date.now()/1000+7*3600);assert.equal(d.episodes.length,0);assert.equal(await claim(),null);
 await sql(`UPDATE sources SET next_scan=-1 WHERE id='${single.id}'`);
 assert.equal((await fetch(origin+'/cdn-cgi/local/scheduled')).status,200);
 assert.equal(await claim(false),null,'Old executor cannot consume a replay-wait scan');
 job=await claim();assert.equal(job.kind,'scan');await scan(job,[]);
 d=await dash();assert.equal(d.sources.find(s=>s.id===single.id).waiting_replay,1);assert.ok(d.jobs.every(j=>j.status==='done'));
 await sql(`UPDATE sources SET next_scan=-1 WHERE id='${single.id}'`);await fetch(origin+'/cdn-cgi/local/scheduled');
 job=await claim();await scan(job,[entry]);
 d=await dash();single=d.sources.find(s=>s.id===single.id);assert.equal(single.waiting_replay,0);assert.ok(single.next_scan>Date.now()/1000+86400*365);
 job=await claim();assert.equal(job.episode.video_id,entry.video_id);assert.equal(job.options.encoding_profile,'m4a:64:source');
 await api(`/api/executor/jobs/${job.id}/fail`,{defer_replay:true},{...auth(),'X-Lease-Token':job.leaseToken});
 d=await dash();assert.ok(d.jobs.some(j=>j.kind==='transcode'&&j.status==='queued'&&j.attempts===0));assert.equal(await claim(),null,'Not-ready archive waits instead of spinning or burning retries');
 await sql(`UPDATE jobs SET available_at=0 WHERE id='${job.id}'`);job=await claim();assert.equal(job.options.encoding_profile,'m4a:64:source');
 const r=await fetch(origin+`/api/executor/jobs/${job.id}/audio`,{method:'POST',headers:{...auth(),'X-Lease-Token':job.leaseToken,'Content-Type':'audio/mp4','X-Audio-Duration':'20'},body:Buffer.from('offline replay audio')});assert.equal(r.status,200);
 let added=await api(`/api/channels/${cid}/sources`,{urls:['https://www.youtube.com/@fixture'],include_replays:true},{},201);assert.equal(added.body.added,2);assert.equal(added.body.duplicates,0);
 d=await dash();assert.ok(d.sources.some(s=>s.url==='https://www.youtube.com/@fixture/streams'));
 added=await api(`/api/channels/${cid}/sources`,{urls:['https://www.youtube.com/@fixture/videos'],include_replays:true});assert.equal(added.body.added,0);assert.equal(added.body.duplicates,2);
 const ordinary=await claim(false);assert.ok(ordinary.source.url.endsWith('/videos'));await scan(ordinary,[entry]);
 assert.equal(await claim(false),null,'Old executor cannot scan /streams');
 const streams=await claim();assert.ok(streams.source.url.endsWith('/streams'));await scan(streams,[entry]);
 assert.equal(await claim(),null,'Same replay found in all sources must not redownload');
 d=await dash();assert.equal(d.episodes.length,1);assert.equal(d.channels.find(c=>c.id===cid).episode_count,1);
 const xml=await (await fetch(origin+`/feed/${d.channels.find(c=>c.id===cid).feed_token}.xml`)).text();assert.equal((xml.match(/<item>/g)||[]).length,1);assert.ok(xml.includes('audio/mp4'));
 await api(`/api/channels/${cid}/sources`,{urls:['https://www.youtube.com/@bad'],include_replays:'true'},{},400);
 console.log('PASS: live waiting survives cron and repeated pending states, old-client gate, finite replay conversion, source expansion/canonical dedup, cross-source cache reuse, single RSS item');
}finally{
 if(machine)await fetch(origin+'/api/executors/'+machine.id,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 if(cid)await fetch(origin+'/api/channels/'+cid,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
}
