import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {validateSourceControls} from '../src/source-controls.js';
import worker from '../src/worker.js';
import {outsideDialog} from '../public/dialog-ui.js';

test('source limits validate strict integers and pause flags; dialog backdrop excludes padding',()=>{
 assert.deepEqual(validateSourceControls({latest_limit:2,paused:false}),{latest_limit:2,paused:false});
 assert.deepEqual(validateSourceControls({sync_minutes:15}),{sync_minutes:15});
 assert.deepEqual(validateSourceControls({sync_minutes:null}),{sync_minutes:null});
 for(const bad of [{},{latest_limit:-1},{latest_limit:101},{latest_limit:2.5},{latest_limit:'2'},{paused:1},{sync_minutes:14},{sync_minutes:15.5},{sync_minutes:'15'},{sync_minutes:10081},{role:'admin'},null])assert.throws(()=>validateSourceControls(bad));
 const rect={left:10,top:20,right:100,bottom:200};
 assert.equal(outsideDialog(rect,9,30),true);assert.equal(outsideDialog(rect,50,201),true);assert.equal(outsideDialog(rect,15,25),false);
});

test('intermediate five-minute Cron ticks only enqueue due source scans',async()=>{
 const writes=[];
 const env={DB:{prepare(query){return {bind(...params){return {run(){writes.push({query,params});}};}};}}};
 await worker.scheduled({cron:'*/5 * * * *',scheduledTime:Date.UTC(2026,10,26,2,10)},env);
 assert.equal(writes.length,1);
 assert.match(writes[0].query,/INSERT OR IGNORE INTO jobs/);
 assert.match(writes[0].query,/s\.paused=0 AND s\.next_scan<=\?/);
});

test('independent source windows union overlapping membership before the channel total; cached episodes survive',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  db.exec("INSERT INTO users(id,username,salt,password_hash,created_at) VALUES('u','fixture','salt','hash',0);INSERT INTO channels(id,user_id,title,feed_token,created_at) VALUES('c','u','test','feed',0);INSERT INTO sources(id,channel_id,url,kind,next_scan,created_at,latest_limit) VALUES('a','c','https://www.youtube.com/@a/videos','author',0,0,2),('b','c','https://www.youtube.com/@b/videos','author',0,0,3);");
  for(const source of ['a','b'])for(let i=0;i<5;i++){
   const id=source+i;db.prepare('INSERT INTO episodes(id,channel_id,video_id,title,published_at,created_at,object_key,size) VALUES(?,?,?,?,?,?,?,16)').run(id,'c',id,id,(source==='a'?100:200)+i,1,'cached/'+id);
   db.prepare('INSERT INTO episode_sources VALUES(?,?,?,?)').run(source,id,1,i+1);
  }
  const active=()=>db.prepare('SELECT id FROM active_episode_window ORDER BY id').all().map(e=>e.id);
  assert.deepEqual(active(),['a3','a4','b2','b3','b4']);
  db.exec("UPDATE sources SET latest_limit=4 WHERE id='a'");assert.equal(active().length,7);
  db.exec("UPDATE channels SET settings='{"+ '"latest_limit":4' +"}' WHERE id='c'");assert.deepEqual(active(),['a4','b2','b3','b4']);
  db.exec("UPDATE channels SET settings='{}' WHERE id='c';UPDATE sources SET latest_limit=1 WHERE id='b';INSERT INTO episode_sources VALUES('b','a0',2,1);");
  assert.deepEqual(active(),['a1','a2','a3','a4','b4'],'A shared episode does not evict B latest because publication order controls the source window');
  db.exec("UPDATE sources SET latest_limit=0 WHERE id='b'");assert.ok(active().includes('a0'),'Any qualifying source can expose an overlapping episode');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM episodes WHERE object_key IS NOT NULL').get().n,10,'Window changes retain every cached audio object');
 }finally{db.close();}
});
