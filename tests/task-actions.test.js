import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {previewTaskAction,applyTaskAction} from '../src/task-actions.js';
import {channelDetail} from '../src/channel-detail.js';
import {userCollection} from '../src/listing.js';
import {reconcileWindow} from '../src/episode-window.js';
import worker from '../src/worker.js';
import {hash} from '../src/lib.js';
import {taskActions,failedTaskChoice} from '../public/task-actions-ui.js';
import {renderChannelDetail} from '../public/channel-detail.js';
import {renderCollection} from '../public/list-ui.js';

async function fixture(){
 const db=new DatabaseSync(':memory:');
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v);},async first(){return db.prepare(sql).get(...values)||null;},async run(){return {meta:{changes:db.prepare(sql).run(...values).changes}};},execute(){const stmt=db.prepare(sql);return stmt.columns().length?{results:stmt.all(...values)}:{results:[],meta:{changes:stmt.run(...values).changes}};}});
 const env={DB:{prepare:statement,async batch(statements){db.exec('BEGIN');try{const r=statements.map(s=>s.execute());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 db.exec("INSERT INTO users(id,username,salt,password_hash,created_at) VALUES('u','fixture','s','h',0),('v','private','s','h',0);INSERT INTO channels(id,user_id,title,feed_token,created_at) VALUES('a','u','Bulk channel','feed-a',0),('b','u','Second channel','feed-b',0),('c','v','Private channel','feed-c',0)");
 const episode=db.prepare('INSERT INTO episodes(id,channel_id,video_id,title,created_at,object_key,size) VALUES(?,?,?,?,1,?,?)');
 const job=db.prepare("INSERT INTO jobs(id,user_id,channel_id,episode_id,source_id,kind,status,error,attempts,available_at,created_at,updated_at) VALUES(?,?,?,?,?,? ,?,?,3,99,?,1)");
 for(let i=0;i<69;i++){
  const channel=i<65?'a':i<67?'b':'c',id='e'+i;
  episode.run(id,channel,id,i<40||i>=65?'Match '+i:'Other '+i,i===0?'cache/audio.m4a':null,i===0?123:0);
  job.run('j'+i,channel==='c'?'v':'u',channel,id,null,'transcode','failed','Fixture error',i);
 }
 db.exec("INSERT INTO sources(id,channel_id,url,kind,next_scan,created_at,paused) VALUES('dup','a','https://youtube.com/@dup','author',0,0,0),('busy','a','https://youtube.com/@busy','author',0,0,0),('paused','a','https://youtube.com/@paused','author',0,0,1)");
 for(const [id,source,status,error,t] of [['dup1','dup','failed','Fixture error',100],['dup2','dup','failed','Fixture error',101],['busy1','busy','failed','Fixture error',100],['busy-active','busy','queued',null,101],['paused1','paused','failed','Fixture error',100],['stopped',null,'failed','来源已暂停',100],['done',null,'done',null,100],['running',null,'running',null,100]])job.run(id,'u','a',null,source,'scan',status,error,t);
 return {db,env,user:{id:'u'},channel:db.prepare("SELECT * FROM channel_preferences WHERE id='a'").get()};
}

test('bulk selection is owner/channel/search scoped and clears across pages without deleting audio or respawning jobs',async()=>{
 const {db,env,user,channel}=await fixture();
 try{
  const detail=await channelDetail(env,channel,new URL('http://localhost/?tab=jobs&q=Match'));
  assert.equal(detail.failedTotal,40);assert.equal(detail.jobs.length,30);
  assert.equal((await userCollection(env,user,new URL('http://localhost/?q=Match'),'jobs')).failedTotal,42);
  const input={action:'dismiss',all:true,channel_id:'a',query:'Match'};
  const preview=await previewTaskAction(env,user,input);assert.deepEqual({...preview},{matched:40,count:40});
  const before=db.prepare('SELECT * FROM episodes ORDER BY id').all();
  assert.equal((await applyTaskAction(env,user,{...input,expected_count:40,expected_matched:40})).changed,40);
  assert.deepEqual(db.prepare('SELECT * FROM episodes ORDER BY id').all(),before,'Every audio key and episode is retained');
  assert.equal((await previewTaskAction(env,user,input)).count,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs WHERE dismissed_at IS NOT NULL').get().n,40);
  assert.equal(db.prepare("SELECT dismissed_at FROM jobs WHERE id='j65'").get().dismissed_at,null,'Other channels remain untouched');
  assert.equal(db.prepare("SELECT dismissed_at FROM jobs WHERE id='j68'").get().dismissed_at,null,'Other owners remain untouched');
  const oldCount=db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  await reconcileWindow(env,'a','u');assert.equal(db.prepare('SELECT COUNT(*) n FROM jobs').get().n,oldCount);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='j1'").get().status,'failed');
  const current=await channelDetail(env,channel,new URL('http://localhost/?tab=jobs&q=Match&offset=999'));
  assert.equal(current.page.total,0);assert.equal(current.page.offset,0);
  assert.equal((await channelDetail(env,channel,new URL('http://localhost/?tab=jobs&tasks=history&q=Match'))).page.total,0,'Cleared failures do not pile up in history');
  const options={escape:String,sortNames:{},statusNames:{},channels:[channel]};
  const episodes=await channelDetail(env,channel,new URL('http://localhost/?q=Match'));
  assert.ok(episodes.episodes.some(e=>e.task_dismissed!=null));
  assert.match(renderChannelDetail(episodes,options),/已停止重试/);
  assert.match(renderChannelDetail(episodes,options),/data-action="regenerate"/);
  assert.match(renderCollection(await userCollection(env,user,new URL('http://localhost/?q=Match'),'episodes'),'episodes',options),/data-action="regenerate"/);
  const token='b'.repeat(64);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await hash(token),'u',9999999999);
  const response=await worker.fetch(new Request('http://localhost/api/episodes/e1/retry',{method:'POST',headers:{Origin:'http://localhost',Cookie:'session='+token}}),env);
  assert.equal(response.status,200);assert.equal(db.prepare("SELECT dismissed_at FROM jobs WHERE id='j1'").get().dismissed_at,null);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='j1'").get().status,'queued','Explicit episode regeneration is still possible');
 }finally{db.close();}
});

test('bulk retry resets selected failures and skips stopped/active/paused/duplicate scans atomically',async()=>{
 const {db,env,user}=await fixture();
 try{
  const mixed={action:'retry',ids:['j1','j2','running','done','stopped','j68']};
  const p=await previewTaskAction(env,user,mixed);assert.equal(p.count,2);
  await applyTaskAction(env,user,{...mixed,expected_count:2,expected_matched:2});
  for(const id of ['j1','j2']){
   const row=db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
   assert.equal(row.status,'queued');assert.equal(row.attempts,0);assert.equal(row.error,null);assert.ok(row.available_at>99);
  }
  const scans={action:'retry',ids:['dup1','dup2','busy1','paused1']};
  assert.deepEqual({...await previewTaskAction(env,user,scans)},{matched:4,count:1});
  await applyTaskAction(env,user,{...scans,expected_count:1,expected_matched:4});
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='dup2'").get().status,'queued');
  assert.deepEqual({...await previewTaskAction(env,user,scans)},{matched:3,count:0});
  await applyTaskAction(env,user,{...scans,action:'dismiss',expected_count:3,expected_matched:3});
  assert.equal(db.prepare("SELECT dismissed_at FROM jobs WHERE id='dup2'").get().dismissed_at,null,'A task that is already queued cannot be cleared');
  const race={action:'dismiss',ids:['j3','j4']};
  assert.equal((await previewTaskAction(env,user,race)).count,2);
  db.exec("UPDATE jobs SET status='running' WHERE id='j4'");
  await assert.rejects(applyTaskAction(env,user,{...race,expected_count:2,expected_matched:2}),e=>e.status===409);
  assert.equal(db.prepare("SELECT dismissed_at FROM jobs WHERE id='j3'").get().dismissed_at,null,'A stale confirmation makes no partial changes');
 }finally{db.close();}
});

test('bulk validation rejects ambiguous or excessive scope and confirms only eligible failures',async()=>{
 const {db,env,user}=await fixture();
 try{
  for(const bad of [null,{},[],{action:'delete',all:true},{action:'dismiss',all:false},{action:'dismiss',all:true,ids:['j1']},{action:'dismiss',ids:[]},{action:'dismiss',ids:['j1','j1']},{action:'dismiss',ids:Array.from({length:81},(_,i)=>'j'+i)},{action:'dismiss',all:true,query:1},{action:'dismiss',all:true,query:'a'.repeat(201)},{action:'dismiss',all:true,extra:true}])await assert.rejects(previewTaskAction(env,user,bad),e=>e.status===400);
  await assert.rejects(previewTaskAction(env,user,{action:'dismiss',all:true,channel_id:'c'}),e=>e.status===404);
  assert.equal((await previewTaskAction(env,user,{action:'dismiss',all:true,query:"' OR 1=1 --"})).count,0);
  await assert.rejects(applyTaskAction(env,user,{action:'dismiss',all:true}),e=>e.status===400);
  assert.equal((await previewTaskAction(env,user,{action:'dismiss',ids:['running','stopped','done','j68']})).count,0);
  assert.match(taskActions({tasks:'current',failedTotal:40,counts:{failed:100}}),/清理全部失败（40）/);
  assert.equal(taskActions({tasks:'history',failedTotal:40}),'');
  assert.equal(failedTaskChoice({id:'stopped',display_status:'stopped',status:'failed'},String),'');
 }finally{db.close();}
});
