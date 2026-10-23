import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import worker from '../src/worker.js';
import {hash} from '../src/lib.js';

test('complete playlist baseline, durable additions, inventory/lease fencing and source isolation',async()=>{
 const db=new DatabaseSync(':memory:');
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v);},async first(){try{return db.prepare(sql).get(...values)||null;}catch(e){console.error(e.message);throw e;}},async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:db.prepare(sql).run(...values).changes}};},execute(){return {results:db.prepare(sql).all(...values)};}});
 const env={DB:{prepare:statement,async batch(batch){db.exec('BEGIN');try{const results=batch.map(s=>s.execute());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');console.error(e.message);throw e;}}}};
 const origin='http://127.0.0.1:8799',token='a'.repeat(64),t=Math.floor(Date.now()/1000);
 const headers={'Authorization':'Bearer '+token,'Content-Type':'application/json','X-Executor-Protocol':'2','X-Executor-Rate-Control':'1','X-Executor-Content-Control':'1','X-Executor-Audio-Control':'1','X-Executor-Replay-Control':'1','X-Executor-Discovery-Control':'1'};
 const call=async(path,data={},extra={},expected=200)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)}),env);assert.equal(response.status,expected,`${path}: ${await response.clone().text()}`);return response.json();};
 const ids=Array.from({length:35},(_,i)=>'video'+String(i).padStart(6,'0'));
 const items=(values)=>values.map((id,i)=>({id,position:i+1}));
 const scan=async(job,selection)=>call(`/api/executor/jobs/${job.id}/scan`,{entries:selection.map(e=>({video_id:e.id,position:e.position,title:e.id,duration:10})),recurring:true},{'X-Lease-Token':job.leaseToken});
 const inventory=async(job,values,expected=200)=>call(`/api/executor/jobs/${job.id}/inventory`,{items:items(values)},{'X-Lease-Token':job.leaseToken},expected);
 const queue=(source='s')=>{db.prepare("INSERT INTO jobs(id,user_id,channel_id,source_id,kind,available_at,created_at,updated_at) VALUES(?, 'u','c',?,'scan',0,0,0)").run(crypto.randomUUID(),source);};
 const claim=async()=>{const leaseToken=crypto.randomUUID();const row=db.prepare("UPDATE jobs SET status='running',executor_id='x',lease_token=?,lease_until=? WHERE id=(SELECT id FROM jobs WHERE status='queued' AND kind='scan' ORDER BY created_at,id LIMIT 1) RETURNING *").get(leaseToken,t+600);return {...row,leaseToken,source:db.prepare('SELECT kind,url FROM sources WHERE id=?').get(row.source_id)};};
 try{
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  db.exec("INSERT INTO users(id,username,salt,password_hash,created_at) VALUES('u','fixture','salt','hash',0);INSERT INTO channels(id,user_id,title,feed_token,created_at) VALUES('c','u','Fixture','feed',0);INSERT INTO sources(id,channel_id,url,kind,next_scan,created_at) VALUES('s','c','https://www.youtube.com/playlist?list=PLfixture','playlist',0,0),('author','c','https://www.youtube.com/@fixture/videos','author',0,0),('other','c','https://www.youtube.com/playlist?list=PLother','playlist',0,0);INSERT INTO execution_policy(user_id,start_interval) VALUES('u',0);");
  db.prepare("INSERT INTO executors(id,user_id,name,token_hash,created_at) VALUES('x','u','fixture',?,0)").run(await hash(token));
  queue();
  let job=await claim();assert.equal(job.source.kind,'playlist');
  await inventory({...job,leaseToken:'wrong'},ids,409);
  await call(`/api/executor/jobs/${job.id}/scan`,{entries:[]},{'X-Lease-Token':job.leaseToken},409);
  const first=await inventory(job,ids);assert.equal(first.selected.length,30);await scan(job,first.selected);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM episodes').get().n,30);
  assert.equal(db.prepare('SELECT SUM(pending) n FROM source_discoveries').get().n,0,'Historical tail is baseline, not queued');
  // Existing transcodes are irrelevant to scanning; retain records but finish jobs.
  db.exec("UPDATE jobs SET status='done'");queue();job=await claim();
  const inserted=['newhead0001',...ids.slice(0,15),'newmid00001',...ids.slice(15),'newtail0001'];
  const update=await inventory(job,inserted);assert.deepEqual(update.selected.map(e=>e.id),['newhead0001','newmid00001','newtail0001']);
  assert.equal(db.prepare('SELECT source_position FROM episodes WHERE video_id=?').get(ids[0]).source_position,2,'Existing playlist positions follow insertion without re-downloading');
  await inventory(job,['duplicate01','duplicate01'],400);
  await call(`/api/executor/jobs/${job.id}/scan`,{entries:[]},{'X-Lease-Token':job.leaseToken},409);
  // Simulate a lost machine after inventory; pending IDs survive a new lease.
  db.prepare("UPDATE jobs SET status='queued',lease_token=NULL,executor_id=NULL,lease_until=NULL,available_at=0 WHERE id=?").run(job.id);
  const retry=await claim();assert.notEqual(retry.leaseToken,job.leaseToken);
  await inventory(job,inserted,409);
  const resumed=await inventory(retry,inserted);assert.deepEqual(resumed.selected,update.selected);await scan(retry,resumed.selected);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM episodes').get().n,33);
  db.exec("UPDATE jobs SET status='done'");queue();job=await claim();
  const burst=Array.from({length:65},(_,i)=>'burst'+String(i).padStart(6,'0'));
  let batch=await inventory(job,[...inserted,...burst]);assert.equal(batch.selected.length,30);assert.equal(batch.has_more,true);await scan(job,batch.selected);
  const due=db.prepare("SELECT next_scan FROM sources WHERE id='s'").get().next_scan;assert.ok(due>=t+899&&due<=Math.floor(Date.now()/1000)+901,'Backlog scans use 15-minute cadence');
  for(const expected of [30,5]){db.exec("UPDATE jobs SET status='done'");queue();job=await claim();batch=await inventory(job,[...inserted,...burst]);assert.equal(batch.selected.length,expected);await scan(job,batch.selected);}
  db.exec("UPDATE jobs SET status='done'");queue();job=await claim();batch=await inventory(job,[...burst,...ids].reverse());assert.deepEqual(batch.selected,[],'Reorder/removal does not requeue historical IDs');await scan(job,[]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM episodes').get().n,98,'Removal does not delete collected episodes');
  db.exec("UPDATE jobs SET status='done'");queue('other');job=await claim();batch=await inventory(job,ids);assert.equal(batch.selected.length,30,'Inventory belongs to each source');await scan(job,batch.selected);
  db.exec("UPDATE jobs SET status='done'");queue('author');job=await claim();await inventory(job,ids,409);
 }finally{db.close();}
});
