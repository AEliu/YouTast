// Isolated local-only collection/physical-quota regression. No YouTube requests.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {fastExecution} from './execution-fixture.mjs';
const origin='http://127.0.0.1:8791',suffix=randomBytes(4).toString('hex');
const admin=JSON.parse(await readFile('test-results/admin-ui-user.json','utf8'));
let cookie='',adminCookie='',uid;const channels=[],machines=[];
async function sql(command){await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--persist-to','.wrangler/admin-state','--command',command],{windowsHide:true});}
async function api(path,data,{status=200,headers={},asAdmin=false}={}) {
 const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',Cookie:asAdmin?adminCookie:cookie,...headers},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,status,`${path}: ${r.status}`);const body=await r.json();return {body,r};
}
const json=async(...args)=>(await api(...args)).body;
const auth=e=>({Authorization:'Bearer '+e.token,'X-Executor-Protocol':'2','X-Executor-Rate-Control':'1','X-Executor-Content-Control':'1'});
let machine;
const claim=async()=> (await json('/api/executor/claim',{}, {headers:auth(machine)})).job;
const entry=(id,date)=>({video_id:id,title:id,duration:1,published_at:date,metadata:{text_language:'zh-CN',complete:true}});
const add=(c,urls)=>json(`/api/channels/${c}/sources`,{urls},{status:201});
const scan=(job,entries)=>json(`/api/executor/jobs/${job.id}/scan`,{entries},{headers:{...auth(machine),'X-Lease-Token':job.leaseToken}});
async function upload(job,size=16,status=200){const r=await fetch(origin+`/api/executor/jobs/${job.id}/audio`,{method:'POST',headers:{...auth(machine),'X-Lease-Token':job.leaseToken,'Content-Type':'audio/mpeg','X-Audio-Duration':'1'},body:Buffer.alloc(size,73)});assert.equal(r.status,status);return r;}
async function channel(title,settings={}) {
 const c=(await json('/api/channels',{title},{status:201})).id;channels.push(c);await settingsFor(c,settings);return c;
}
async function settingsFor(c,settings){await json(`/api/channels/${c}/settings`,{title:'Collection '+c,description:'',settings,rss_metadata:{author:'',image:'',language:'inherit',category:'Education',explicit:false}});}
try {
 await sql('DELETE FROM login_limits');
 let login=await api('/api/auth/login',{username:admin.username,password:admin.password});adminCookie=login.r.headers.get('set-cookie').split(';')[0];
 const reg=await api('/api/auth/register',{username:'collection_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});cookie=reg.r.headers.get('set-cookie').split(';')[0];uid=reg.body.user.id;
 await fastExecution(origin,cookie);machine=await json('/api/executors',{name:'offline collection'},{status:201});machines.push(machine);
 const defaults=(await json('/api/settings')).settings;
 await json('/api/settings',{settings:{...defaults,scan_limit:7,retention_days:13,sync_hours:3,feed_limit:17}});
 const primary=await channel('Recent collection');
 const old=entry('oldvideo001',1500000000),recent=[entry('newvideo001',1700000001),entry('newvideo002',1700000002),entry('newvideo003',1700000003)];
 await add(primary,['https://www.youtube.com/watch?v='+old.video_id]);await scan(await claim(),[old]);await upload(await claim());
 await settingsFor(primary,{latest_limit:2,scan_limit:7,sort_mode:'source'});
 await add(primary,['https://www.youtube.com/@inactive/videos','https://www.youtube.com/@recent/videos']);
 const scans=await Promise.all([claim(),claim()]);assert.ok(scans.every(j=>j.kind==='scan'));assert.ok(scans.every(j=>j.options.scan_limit===7));
 const freshScan=scans.find(j=>j.source.url.includes('@recent'));await scan(freshScan,recent);
 assert.equal(await claim(),null,'No downloads before all collection sources finish');
 await scan(scans.find(j=>j!==freshScan),[old,recent[1],entry('oldvideo002',1500000001)]);
 const chosen=await Promise.all([claim(),claim()]);assert.deepEqual(chosen.map(j=>j.episode.video_id).sort(),['newvideo002','newvideo003']);assert.equal(await claim(),null);
 for(const job of chosen)await upload(job);
 let d=await json('/api/dashboard'),p=d.channels.find(c=>c.id===primary);assert.equal(p.episode_count,2);assert.equal(p.archived_count,1);assert.equal(d.bytes,48);
 let feed=await (await fetch(origin+`/feed/${p.feed_token}.xml`)).text();assert.ok(!feed.includes(old.video_id));assert.deepEqual([...feed.matchAll(/<item><title>(.*?)<\/title>/g)].map(m=>m[1]),['newvideo003','newvideo002']);assert.ok(feed.includes('<itunes:type>episodic</itunes:type>'));assert.ok(!feed.includes('<itunes:episode>'));
 await json(`/api/channels/${primary}/sort`,{sort_mode:'source_grouped'});
 feed=await (await fetch(origin+`/feed/${p.feed_token}.xml`)).text();assert.deepEqual([...feed.matchAll(/<item><title>(.*?)<\/title>/g)].map(m=>m[1]),['newvideo002','newvideo003']);
 await json(`/api/channels/${primary}/sort`,{sort_mode:'source'});
 const alias=await channel('Shared cache alias',{latest_limit:1});await add(alias,['https://www.youtube.com/watch?v='+old.video_id,'https://www.youtube.com/watch?v=newvideo003']);
 d=await json('/api/dashboard');assert.equal(d.bytes,48,'Shared cached audio is counted once');
 await json(`/api/admin/users/${uid}`,{role:'user',disabled:false,storage_limit_bytes:48,monthly_transfer_limit_bytes:null},{asAdmin:true});
 await json(`/api/channels/${primary}/sync`,{});
 const rechecks=await Promise.all([claim(),claim(),claim()]);assert.ok(rechecks.every(j=>j?.kind==='scan'));
 const newest=entry('newvideo004',1700000004);
 for(const j of rechecks)await scan(j,j.source.url.includes('@recent')?[newest,...recent]:j.source.kind==='video'?[old]:[old]);
 const next=await claim();assert.equal(next.episode.video_id,newest.video_id);
 await upload(next,16,409);assert.equal((await json('/api/dashboard')).bytes,48,'Cleanup disabled by default');
 await json('/api/settings',{settings:{...defaults,scan_limit:7,storage_cleanup:'oldest'}});
 await upload(next,64,409);assert.equal((await json('/api/dashboard')).bytes,48,'Hopeless oversize upload must not evict audio');
 await sql("INSERT OR REPLACE INTO storage_cleanup_locks(lock_key,token,lease_until) VALUES('quota','test-held-lock',unixepoch()+60)");
 await upload(next,16,409);assert.equal((await json('/api/dashboard')).bytes,48,'Concurrent cleanup lock prevents extra eviction');
 await sql("DELETE FROM storage_cleanup_locks WHERE token='test-held-lock'");
 await upload(next);
 d=await json('/api/dashboard');assert.equal(d.bytes,48);p=d.channels.find(c=>c.id===primary);assert.equal(p.episode_count,2);
 const saved=await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--persist-to','.wrangler/admin-state','--json','--command',`SELECT e.object_key,e.cleanup_reason FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE c.user_id='${uid}' AND e.video_id='oldvideo001'`],{windowsHide:true});
 const records=JSON.parse(saved.stdout.slice(saved.stdout.indexOf('[')))[0].results;assert.equal(records.length,2);assert.ok(records.every(e=>e.object_key===null&&e.cleanup_reason==='quota'),'All same-owner references to the evicted object are cleared');
 assert.equal(await claim(),null,'Quota evictions must not automatically redownload');
 await settingsFor(primary,{latest_limit:3,scan_limit:7,sort_mode:'source'});assert.equal(await claim(),null,'Expanding latest N reuses retained old audio');
 assert.equal((await json('/api/dashboard')).channels.find(c=>c.id===primary).episode_count,3);
 console.log('PASS: custom numeric values, merged global latest N, inactive-source exclusion, scan barrier, RSS/archive separation, no automatic redownload, opt-in physical quota cleanup, shared-reference deletion, lock and oversize protection');
}finally{
 await sql("DELETE FROM storage_cleanup_locks WHERE token='test-held-lock'");
 for(const e of machines)await fetch(origin+'/api/executors/'+e.id,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 for(const c of channels)await fetch(origin+'/api/channels/'+c,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 await sql('DELETE FROM login_limits');
}
