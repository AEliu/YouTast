import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {deleteSelectedAudio} from '../src/audio-actions.js';
import {audioChoice,audioActions} from '../public/audio-actions-ui.js';
import {renderChannelDetail} from '../public/channel-detail.js';
import {renderCollection} from '../public/list-ui.js';
import worker from '../src/worker.js';
import {hash} from '../src/lib.js';

async function fixture() {
 const db=new DatabaseSync(':memory:');
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v);},async first(){return db.prepare(sql).get(...values)||null;},async all(){return {results:db.prepare(sql).all(...values)};},async run(){return {meta:{changes:db.prepare(sql).run(...values).changes}};},execute(){const s=db.prepare(sql);return s.columns().length?{results:s.all(...values)}:{results:[],meta:{changes:s.run(...values).changes}};}});
 const env={DB:{prepare:statement,async batch(statements){db.exec('BEGIN');try{const out=statements.map(s=>s.execute());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}},AUDIO:{async delete(){}}};
 db.exec(`INSERT INTO users(id,username,salt,password_hash,created_at) VALUES('u','owner','s','h',0),('v','other','s','h',0);
 INSERT INTO channels(id,user_id,title,feed_token,created_at) VALUES('a','u','A','feed-a',0),('b','u','B','feed-b',0),('c','v','C','feed-c',0);
 INSERT INTO episodes(id,channel_id,video_id,title,created_at,object_key,size) VALUES
 ('one','a','1','One',1,'u/shared',100),('shared','b','2','Shared',1,'u/shared',100),('busy','a','3','Busy',1,'u/busy',30),('private','c','4','Private',1,'v/private',40),('empty','a','5','Empty',1,NULL,0);
 INSERT INTO jobs(id,user_id,channel_id,episode_id,kind,status,available_at,created_at,updated_at) VALUES
 ('j1','u','a','one','transcode','done',0,1,1),('j2','u','a','busy','transcode','running',0,1,1),('j3','v','c','private','transcode','done',0,1,1);`);
 return {db,env,user:{id:'u'}};
}

test('batch deletion is owner scoped, skips active or missing audio, and preserves shared objects',async()=>{
 const {db,env,user}=await fixture();
 try {
  assert.deepEqual(await deleteSelectedAudio(env,user,{ids:['one','busy','private','empty','missing']}),{ok:true,changed:1,skipped:4});
  assert.equal(db.prepare("SELECT object_key FROM episodes WHERE id='one'").get().object_key,null);
  assert.equal(db.prepare("SELECT object_key FROM episodes WHERE id='shared'").get().object_key,'u/shared');
  assert.equal(db.prepare("SELECT object_key FROM episodes WHERE id='busy'").get().object_key,'u/busy');
  assert.equal(db.prepare("SELECT object_key FROM episodes WHERE id='private'").get().object_key,'v/private');
  assert.equal(db.prepare("SELECT error FROM jobs WHERE id='j1'").get().error,'音频已由用户删除');
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id='j2'").get().status,'running');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM object_gc').get().n,0);
  assert.equal((await deleteSelectedAudio(env,user,{ids:['shared']})).changed,1);
  assert.equal(db.prepare('SELECT object_key FROM object_gc').get().object_key,'u/shared');
  for(const bad of [null,{}, {ids:[]},{ids:['one','one']},{ids:Array.from({length:81},(_,i)=>String(i))},{ids:['one'],all:true}])await assert.rejects(deleteSelectedAudio(env,user,bad),e=>e.status===400);
  assert.match(audioActions([{object_key:'u/x'}]),/全选本页音频/);
  assert.match(audioChoice({id:'a',title:'A',object_key:'u/x'},String),/data-audio-choice/);
  assert.equal(audioChoice({id:'a',title:'A',object_key:null},String),'');
  const episode={id:'x',channel_id:'a',channel_title:'A',title:'An episode',duration:60,object_key:'u/x',size:10};
  const page={offset:0,limit:30,total:1,hasMore:false},options={escape:String,sortNames:{},statusNames:{},channels:[{id:'a',feed_token:'f'}]};
  const detail={channel:{id:'a',title:'A',sync_hours:6,feed_token:'f'},counts:{episodes:1,ready:1,archived:1,jobs:0,active:0},sources:[],episodes:[episode],jobs:[],tab:'episodes',page};
  for(const html of [renderCollection({episodes:[episode],page,query:''},'episodes',options),renderChannelDetail(detail,options),renderChannelDetail({...detail,tab:'archive'},options)]) {
   assert.match(html,/全选本页音频/);assert.match(html,/data-audio-choice/);
  }
 } finally {db.close();}
});

test('failed storage cleanup keeps its reservation for a later retry',async()=>{
 const {db,env}=await fixture();
 let pending;
 env.AUDIO.delete=async()=>{throw new Error('storage unavailable');};
 try {
  const token='d'.repeat(64);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await hash(token),'u',9999999999);
  const response=await worker.fetch(new Request('http://localhost/api/episodes/bulk-delete',{method:'POST',headers:{Origin:'http://localhost',Cookie:'session='+token,'Content-Type':'application/json'},body:JSON.stringify({ids:['one','shared']})}),env,{waitUntil(promise){pending=promise;}});
  assert.equal(response.status,200);await pending;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM object_gc').get().n,1);
 } finally {db.close();}
});

test('batch API responds before physical storage deletion and retains the GC reservation until completion',async()=>{
 const {db,env}=await fixture();
 let release; const blocked=new Promise(resolve=>{release=resolve;}); let pending;
 env.AUDIO.delete=async()=>blocked;
 try {
  const token='c'.repeat(64);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await hash(token),'u',9999999999);
  const request=new Request('http://localhost/api/episodes/bulk-delete',{method:'POST',headers:{Origin:'http://localhost',Cookie:'session='+token,'Content-Type':'application/json'},body:JSON.stringify({ids:['one','shared']})});
  const response=await worker.fetch(request,env,{waitUntil(promise){pending=promise;}});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,changed:2,skipped:0});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM object_gc').get().n,1);
  release();await pending;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM object_gc').get().n,0);
 } finally {release();if(pending)await pending;db.close();}
});
