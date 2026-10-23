import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
// Isolated local API and real local D1/R2 only. No YouTube requests.
import assert from 'node:assert/strict';
import {fastExecution} from './execution-fixture.mjs';
import {randomBytes} from 'node:crypto';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8787',suffix=randomBytes(5).toString('hex');
const accounts=[],sql=localDatabase(origin,process.env.TEST_PERSIST_TO);
const channels=[];let cookie='',machine;
async function api(path,data,options={}) {
 const r=await fetch(origin+path,{method:options.method||(data?'POST':'GET'),headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...options.headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,options.status||200,`${path}: HTTP ${r.status}`);return r.json();
}
async function channel(title){const c=await api('/api/channels',{title},{status:201});channels.push(c.id);return c.id;}
const headers=job=>({Authorization:`Bearer ${machine.token}`,'X-Executor-Protocol':'2',...(job?{'X-Lease-Token':job.leaseToken}:{})});
const claim=async(protocol=true)=>(await api('/api/executor/claim',{}, {headers:protocol?headers():{Authorization:`Bearer ${machine.token}`}})).job;
const url='https://www.youtube.com/watch?v=abcdefghijk';
const entry={video_id:'abcdefghijk',title:'Episode <safe>',duration:12,published_at:1600000000};
async function add(cid){return api(`/api/channels/${cid}/sources`,{urls:[url]},{status:201});}
async function finish(job) {
 const metadata={text_language:job.options.text_language,complete:true,description:'Original description <script>bad</script>\n00:00 Introduction\n00:05 Chapter two',author:'Creator & A',thumbnail:'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg',language:'en',chapters:[{startTime:0,title:'Introduction'},{startTime:5,title:'Chapter two'}]};
 await api(`/api/executor/jobs/${job.id}/metadata`,{metadata},{headers:headers(job)});
 const r=await fetch(origin+`/api/executor/jobs/${job.id}/audio`,{method:'POST',headers:{...headers(job),'Content-Type':'audio/mpeg','X-Audio-Duration':'12'},body:Buffer.from('ID3preferences')});assert.equal(r.status,200);
}
async function discover(){const job=await claim();assert.equal(job.kind,'scan');await api(`/api/executor/jobs/${job.id}/scan`,{entries:[entry]},{headers:headers(job)});return job;}
try {
 const r=await fetch(origin+'/api/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'preferences_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'})});assert.ok(r.ok);cookie=r.headers.get('set-cookie').split(';')[0];
 accounts.push({id:(await r.json()).user.id,username:'preferences_'+suffix});
 await fastExecution(origin,cookie);
 let settings=(await api('/api/settings')).settings;assert.equal(settings.retention_days,0);assert.equal(settings.bitrate,64);
 await api('/api/settings',{settings:{...settings,scan_limit:999}},{status:400});
 machine=await api('/api/executors',{name:'preferences-test'},{status:201});
 const a=await channel('Default audio'),b=await channel('Shared audio forever');
 await add(a);await discover();const firstConversion=await claim();
 await sql(`UPDATE executors SET minimum_protocol=2 WHERE id='${machine.id}'`);
 const drained=await api('/api/executor/claim',{}, {headers:{Authorization:`Bearer ${machine.token}`}});
 assert.equal(drained.upgradeRequired,true);assert.equal(drained.job,null);
 await api(`/api/executor/jobs/${firstConversion.id}/heartbeat`,{}, {headers:{Authorization:`Bearer ${machine.token}`,'X-Lease-Token':firstConversion.leaseToken}});
 await finish(firstConversion);
 assert.equal((await add(b)).reused,1);
 let d=await api('/api/dashboard');const aChannel=d.channels.find(c=>c.id===a),bChannel=d.channels.find(c=>c.id===b),aEpisode=d.episodes.find(e=>e.channel_id===a);
 const rss_metadata={author:'Custom author',image:'https://example.com/cover.jpg',language:'en',category:'Education',explicit:false};
 await api(`/api/channels/${a}/settings`,{title:'Custom channel',description:'Custom & description',settings:{retention_days:7},rss_metadata});
 const feed=await (await fetch(`${origin}/feed/${aChannel.feed_token}.xml`)).text();assert.ok(feed.includes('Custom channel'));assert.ok(feed.includes('Custom author'));assert.ok(feed.includes('<language>en</language>'));assert.ok(feed.includes('<podcast:chapters'));assert.ok(!feed.includes('<script>'));
 const chapterUrl=`${origin}/chapters/${aChannel.feed_token}/${aEpisode.id}.json`;
 let chapter=await fetch(chapterUrl);assert.equal(chapter.status,200);assert.equal((await chapter.json()).chapters[1].startTime,5);
 assert.equal((await fetch(`${origin}/chapters/${bChannel.feed_token}/${aEpisode.id}.json`)).status,404);
 settings={...settings,bitrate:128,text_language:'en',scan_limit:100,sync_hours:24,sort_mode:'published_desc'};
 await api('/api/settings',{settings});
 const c=await channel('Different encoding');assert.equal((await add(c)).reused,0,'128 kbps must not reuse 64 kbps');
 assert.equal(await claim(false),null,'Old executor must not process settings it cannot honor');
 const scan=await discover();assert.equal(scan.options.scan_limit,100);assert.equal(scan.options.sync_hours,24);
 const convert=await claim();assert.equal(convert.options.bitrate,128);assert.equal(convert.options.text_language,'en');
 await finish(convert);
 d=await api('/api/dashboard');assert.equal(d.episodes.find(e=>e.channel_id===c).encoding_profile,'mp3:128:original');assert.notEqual(d.episodes.find(e=>e.channel_id===c).object_key,aEpisode.object_key);
 const cEpisode=d.episodes.find(e=>e.channel_id===c);
 const translated=await channel('Different text, same audio');
 await api(`/api/channels/${translated}/settings`,{title:'日本語の文字',description:'',settings:{text_language:'ja'},rss_metadata});
 await api(`/api/channels/${translated}/sources`,{urls:['https://www.youtube.com/playlist?list=PLlocalized123456']},{status:201});
 const localizedScan=await claim();assert.equal(localizedScan.kind,'scan');assert.equal(localizedScan.options.text_language,'ja');
 await api(`/api/executor/jobs/${localizedScan.id}/scan`,{entries:[{...entry,title:'日本語のタイトル',metadata:{text_language:'ja',complete:false}}]},{headers:headers(localizedScan)});
 const metadataJob=await claim();assert.equal(metadataJob.options.metadata_only,true,'Text language change must not re-download audio');
 await api(`/api/executor/jobs/${metadataJob.id}/metadata`,{title:'日本語のタイトル',metadata:{text_language:'ja',complete:true,description:'日本語の説明',chapters:[{startTime:0,title:'はじめに'}]},complete_job:true},{headers:headers(metadataJob)});
 d=await api('/api/dashboard');const localizedEpisode=d.episodes.find(e=>e.channel_id===translated);
 assert.equal(localizedEpisode.object_key,cEpisode.object_key,'Different text languages share the same audio');assert.equal(JSON.parse(localizedEpisode.metadata).description,'日本語の説明');assert.equal(localizedEpisode.title,'日本語のタイトル');

 await sql(`UPDATE episodes SET ready_at=unixepoch()-8*86400 WHERE channel_id='${a}'`);
 const scheduled=await fetch(origin+'/cdn-cgi/local/scheduled');assert.equal(scheduled.status,200);
 d=await api('/api/dashboard');assert.equal(d.episodes.find(e=>e.channel_id===a).object_key,null);assert.ok(d.episodes.find(e=>e.channel_id===b).object_key,'Other reference must survive retention cleanup');assert.equal((await fetch(chapterUrl)).status,404);
 const bEpisode=d.episodes.find(e=>e.channel_id===b);assert.equal((await fetch(`${origin}/media/${bChannel.feed_token}/${bEpisode.id}.mp3`)).status,200);
 assert.equal((await fetch(`${origin}/feed/${aChannel.feed_token}.xml`)).status,200);
 await api(`/api/episodes/${aEpisode.id}/retry`,{});assert.equal(await claim(),null,'Expired episode may reuse a matching existing encoding');
 d=await api('/api/dashboard');assert.ok(d.episodes.find(e=>e.id===aEpisode.id).object_key);assert.equal(d.episodes.find(e=>e.id===aEpisode.id).expired_at,null);
 await api(`/api/channels/${b}/settings`,{title:'Expired cached audio',description:'',settings:{retention_days:7},rss_metadata});
 await sql(`UPDATE episodes SET ready_at=unixepoch()-8*86400 WHERE channel_id='${b}'`);
 assert.equal((await fetch(origin+'/cdn-cgi/local/scheduled')).status,200);
 assert.equal((await fetch(`${origin}/media/${bChannel.feed_token}/${bEpisode.id}.mp3`)).status,404);
 await api(`/api/episodes/${bEpisode.id}/retry`,{});assert.equal(await claim(),null,'Originally instant-reused audio without a job can be regenerated');
 assert.ok((await api('/api/dashboard')).episodes.find(e=>e.id===bEpisode.id).object_key);
 await api(`/api/channels/${b}/rotate`,{});assert.equal((await fetch(`${origin}/chapters/${bChannel.feed_token}/${bEpisode.id}.json`)).status,404);
 const many=await channel('100 source entries');
 await api(`/api/channels/${many}/sources`,{urls:['https://www.youtube.com/playlist?list=PLmanyentries12345']},{status:201});
 const largeScan=await claim();assert.equal(largeScan.kind,'scan');assert.equal(largeScan.options.scan_limit,100);
 const manyEntries=Array.from({length:100},(_,i)=>({video_id:'scan'+String(i).padStart(7,'0'),title:'节'.repeat(300),duration:1,position:i+1}));
 await api(`/api/executor/jobs/${largeScan.id}/scan`,{entries:[...manyEntries,manyEntries[0]]},{headers:headers(largeScan),status:400});
 await api(`/api/executor/jobs/${largeScan.id}/scan`,{entries:manyEntries},{headers:headers(largeScan)});
 assert.equal((await api('/api/dashboard')).episodes.filter(e=>e.channel_id===many).length,100);
 console.log('PASS: settings inheritance, channel RSS metadata, chapters/private access, encoding-aware reuse, executor capability gate and shared-reference retention');
} finally {
 try{
 if(machine)await api(`/api/executors/${machine.id}`,undefined,{method:'DELETE'});
 for(const cid of channels)await api(`/api/channels/${cid}`,undefined,{method:'DELETE'});

 }finally{await cleanupLocalUsers({origin,sql,accounts});}
}
