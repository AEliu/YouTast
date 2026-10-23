// Local-only regression. Real API/SQLite/R2; deliberately complete audio out of order.
import assert from 'node:assert/strict';
import {fastExecution} from './execution-fixture.mjs';
import {randomBytes} from 'node:crypto';
const origin='http://127.0.0.1:8787',suffix=randomBytes(5).toString('hex');
let cookie='',cid,e;
async function api(path,data,options={}) {
  const r=await fetch(origin+path,{method:options.method||(data?'POST':'GET'),headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...options.headers},body:data?JSON.stringify(data):undefined});
  assert.equal(r.status,options.status||200,`${path}: ${r.status}`);
  return r.json();
}
const auth=()=>({Authorization:`Bearer ${e.token}`});
const claim=async()=> (await api('/api/executor/claim',{}, {headers:auth()})).job;
const ids=['playlist001','playlist002','author00001','author00002','single00001','single00002'];
const entries=[{video_id:ids[0],title:'Playlist first',duration:1,published_at:1600000100,position:1},{video_id:ids[1],title:'Playlist second',duration:1,published_at:1600000000,position:2},
 {video_id:ids[2],title:'Author latest',duration:1,published_at:1700000000,position:1},{video_id:ids[3],title:'Author oldest',duration:1,published_at:1500000000,position:2},
 {video_id:ids[4],title:'Single added first',duration:1,published_at:1400000000,position:1},{video_id:ids[5],title:'Single added last',duration:1,published_at:1750000000,position:1}];
const urls=['https://www.youtube.com/playlist?list=PLsorting012345','https://www.youtube.com/@sorting_author/videos',...ids.slice(4).map(id=>`https://www.youtube.com/watch?v=${id}`)];
let feedToken;
const feed=async()=>{const r=await fetch(`${origin}/feed/${feedToken}.xml`);assert.equal(r.status,200);return r.text();};
const order=xml=>[...xml.matchAll(/<item><title>(.*?)<\/title>/g)].map(m=>m[1]);
const expected=indexes=>indexes.map(i=>entries[i].title);
try {
 const r=await fetch(origin+'/api/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({username:'sort_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'})});
 assert.ok(r.ok);cookie=r.headers.get('set-cookie').split(';')[0];
 await fastExecution(origin,cookie);
 cid=(await api('/api/channels',{title:'Local sorting '+suffix},{status:201})).id;
 e=await api('/api/executors',{name:'sorting-test'},{status:201});
 await api(`/api/channels/${cid}/sources`,{urls},{status:201});
 // Complete each bounded batch in reverse; global concurrency is capped at three.
 async function drain(reordered=false) {
  let scans=0,transcodes=0;
  for(let round=0;round<20;round++) {
   const jobs=(await Promise.all(Array.from({length:3},()=>claim()))).filter(Boolean);
   if(!jobs.length)return {scans,transcodes};
   for(const job of jobs.reverse()) {
    if(job.kind==='scan') {
     const index=urls.indexOf(job.source.url);
     const batch=index===0?(reordered?[{...entries[1],position:1},{...entries[0],position:2}]:entries.slice(0,2)):index===1?entries.slice(2,4):[entries[index+2]];
     await api(`/api/executor/jobs/${job.id}/scan`,{entries:batch},{headers:{...auth(),'X-Lease-Token':job.leaseToken}});scans++;
    }else {
     const meta=entries.find(x=>x.video_id===job.episode.video_id);
     const r=await fetch(origin+`/api/executor/jobs/${job.id}/audio`,{method:'POST',headers:{...auth(),'X-Lease-Token':job.leaseToken,'Content-Type':'audio/mpeg','X-Published-At':String(meta.published_at)},body:Buffer.from('ID3sort')});
     assert.equal(r.status,200);transcodes++;
    }
   }
  }
  throw new Error('Offline drain did not converge');
 }
 assert.deepEqual(await drain(),{scans:4,transcodes:6});
 const d=await api('/api/dashboard');feedToken=d.channels.find(c=>c.id===cid).feed_token;
 const guids=[...(await feed()).matchAll(/<guid isPermaLink="false">(.*?)<\/guid>/g)].map(m=>m[1]).sort();
 assert.deepEqual(order(await feed()),expected([0,1,3,2,4,5]));
 assert.deepEqual((await api(`/api/channels/${cid}/detail`)).episodes.map(e=>e.title),expected([0,1,3,2,4,5]));
 for(const [sort_mode,indexes] of Object.entries({added_asc:[0,1,2,3,4,5],added_desc:[5,4,3,2,1,0],published_asc:[4,3,1,0,2,5],published_desc:[5,2,0,1,3,4]})) {
   await api(`/api/channels/${cid}/sort`,{sort_mode});
   assert.deepEqual(order(await feed()),expected(indexes));
   const detail=await api(`/api/channels/${cid}/detail`);assert.deepEqual(detail.episodes.map(e=>e.title),expected(indexes),'Detail pagination uses RSS channel order');
   assert.deepEqual([...(await feed()).matchAll(/<guid isPermaLink="false">(.*?)<\/guid>/g)].map(m=>m[1]).sort(),guids);
 }
 await api(`/api/channels/${cid}/sort`,{sort_mode:'sql injection'},{status:400});
 await api(`/api/channels/${cid}/sort`,{sort_mode:'source'});
 // A metadata-only rescan follows a reordered playlist without re-encoding its audio.
 await api(`/api/channels/${cid}/sync`,{});
 assert.deepEqual(await drain(true),{scans:4,transcodes:0},'Rescan must not schedule duplicate transcodes');
 assert.deepEqual(order(await feed()),expected([1,0,3,2,4,5]));
 await api(`/api/channels/${cid}/sort`,{sort_mode:'added_asc'});
 assert.deepEqual(order(await feed()),expected([0,1,2,3,4,5]),'Joining order survives a playlist rearrangement');
 await api(`/api/channels/${cid}/sort`,{sort_mode:'source'});
 const source=d.sources.find(s=>s.channel_id===cid&&s.kind==='playlist');
 await api(`/api/channels/${cid}/sources/${source.id}`,undefined,{method:'DELETE'});
 assert.deepEqual(order(await feed()),expected([1,0,3,2,4,5]),'Deleting source preserves sort provenance');
 console.log('PASS: source defaults, inverted scan/upload completion, five channel sort modes, stable RSS GUIDs and deleted-source order');
} finally {
 if(e)await api(`/api/executors/${e.id}`,undefined,{method:'DELETE'});
 if(cid)await api(`/api/channels/${cid}`,undefined,{method:'DELETE'});
}
