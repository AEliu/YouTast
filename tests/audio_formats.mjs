import {fetchWithDiscovery as fetch} from './discovery-fixture.mjs';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
// Local API/SQLite/R2 contract for mixed feeds and format-aware reuse; no YouTube.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8787',suffix=randomBytes(4).toString('hex');
const accounts=[],sql=localDatabase(origin,process.env.TEST_PERSIST_TO);
let cookie='',machine;const channels=[];
async function api(path,data,headers={},status=200){
 const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,status,`${path}: ${r.status}`);return {r,body:await r.json()};
}
const auth=(modern=true)=>({Authorization:'Bearer '+machine.token,'X-Executor-Protocol':'2',...(modern?{'X-Executor-Audio-Control':'1'}:{})});
const claim=async(modern=true)=>(await api('/api/executor/claim',{},auth(modern))).body.job;
async function channel(mode){const c=(await api('/api/channels',{title:'Audio '+mode},{},201)).body.id;channels.push(c);if(mode)await api(`/api/channels/${c}/settings`,{title:'Audio '+mode,description:'',settings:{audio_mode:mode},rss_metadata:{author:'',image:'',language:'inherit',category:'Education',explicit:false}});return c;}
const add=(c,id)=>api(`/api/channels/${c}/sources`,{urls:['https://www.youtube.com/watch?v='+id]},{},201);
async function discover(id){const j=await claim(false);assert.equal(j.kind,'scan');await api(`/api/executor/jobs/${j.id}/scan`,{entries:[{video_id:id,title:id,duration:2}]},{...auth(false),'X-Lease-Token':j.leaseToken});}
async function upload(j,mime,status=200){const r=await fetch(origin+`/api/executor/jobs/${j.id}/audio`,{method:'POST',headers:{...auth(),'X-Lease-Token':j.leaseToken,'Content-Type':mime,'X-Audio-Duration':'2'},body:Buffer.from('offline audio fixture bytes')});assert.equal(r.status,status);}
try{
 let r=await api('/api/auth/register',{username:'formats_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});cookie=r.r.headers.get('set-cookie').split(';')[0];
 accounts.push({id:r.body.user.id,username:'formats_'+suffix});
 assert.equal((await api('/api/settings')).body.settings.audio_mode,'source');
 await api('/api/execution-policy',{concurrency:3,start_interval:0,request_interval:0,download_wait:0,cooldown_seconds:60,paused:false});
 machine=(await api('/api/executors',{name:'formats'},{},201)).body;
 const c=await channel();await add(c,'aacvideo001');await discover('aacvideo001');
 assert.equal(await claim(false),null,'Old executor cannot claim M4A conversion');
 const job=await claim();assert.equal(job.options.encoding_profile,'m4a:64:source');
 await upload(job,'audio/mpeg',415);await upload(job,'audio/aac',415);await upload(job,'audio/mp4');
 const alias=await channel();assert.equal((await add(alias,'aacvideo001')).body.reused,1);
 const compact=await channel('compact');await add(compact,'aacvideo001');await discover('aacvideo001');
 const cj=await claim();assert.equal(cj.options.encoding_profile,'m4a:64:compact');await upload(cj,'audio/mp4');
 await api(`/api/channels/${c}/settings`,{title:'Mixed audio',description:'',settings:{audio_mode:'mp3'},rss_metadata:{author:'',image:'',language:'inherit',category:'Education',explicit:false}});
 await add(c,'mp3video001');await discover('mp3video001');const old=await claim(false);assert.equal(old.options.encoding_profile,'mp3:64:original');await upload(old,'audio/mpeg');
 const d=(await api('/api/dashboard')).body,feedToken=d.channels.find(x=>x.id===c).feed_token;
 const xml=await (await fetch(origin+`/feed/${feedToken}.xml`)).text();
 assert.ok(xml.includes('.m4a" length="')&&xml.includes('type="audio/mp4"'));assert.ok(xml.includes('.mp3" length="')&&xml.includes('type="audio/mpeg"'));
 for(const e of d.episodes.filter(e=>e.channel_id===c)){
  const ext=e.object_key.endsWith('.m4a')?'m4a':'mp3',url=origin+`/media/${feedToken}/${e.id}.${ext}`;
  let r=await fetch(url,{method:'HEAD'});assert.equal(r.headers.get('content-type'),ext==='m4a'?'audio/mp4':'audio/mpeg');assert.equal(Number(r.headers.get('content-length')),e.size);
  r=await fetch(url,{headers:{Range:'bytes=0-3'}});assert.equal(r.status,206);assert.equal((await r.arrayBuffer()).byteLength,4);
 }
 assert.equal((await api('/api/executor/status',{},auth())).body.audioControlVersion,0,'Legacy claim accurately reports old capability');
 console.log('PASS: default AAC, old-executor gate, MIME validation, source/compact cache isolation, source reuse, mixed MP3/M4A RSS, HEAD and Range');
}finally{
 try{
 if(machine)await fetch(origin+'/api/executors/'+machine.id,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 for(const c of channels)await fetch(origin+'/api/channels/'+c,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});

 }finally{await cleanupLocalUsers({origin,sql,accounts});}
}
