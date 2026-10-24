import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {channelDetail} from '../src/channel-detail.js';
import worker from '../src/worker.js';
import {hash} from '../src/lib.js';
import {windowCte} from '../src/window-query.js';
import assert from 'node:assert/strict';
import test from 'node:test';

async function fixture(){
 const db=new DatabaseSync(':memory:');
 for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v);},async first(){return db.prepare(sql).get(...values)||null;},execute(){return {results:db.prepare(sql).all(...values)};}});
 const env={DB:{prepare:statement,async batch(statements){return statements.map(s=>s.execute());}}};
 db.exec("INSERT INTO users(id,username,salt,password_hash,created_at) VALUES('u','fixture','salt','hash',0),('other','other','salt','hash',0)");
 const channel=db.prepare('INSERT INTO channels(id,user_id,title,feed_token,created_at,settings) VALUES(?,?,?,?,?,?)');
 const source=db.prepare('INSERT INTO sources(id,channel_id,url,kind,next_scan,created_at,latest_limit) VALUES(?,?,?,?,0,0,?)');
 const episode=db.prepare('INSERT INTO episodes(id,channel_id,video_id,title,published_at,created_at,object_key,size,source_kind,metadata) VALUES(?,?,?,?,?,?,?,16,?,?)');
 const member=db.prepare('INSERT INTO episode_sources VALUES(?,?,?,?)');
 db.exec('BEGIN');
 for(let c=0;c<20;c++){
  const cid='c'+c;channel.run(cid,c<4?'u':'other',cid,'feed'+c,1,JSON.stringify({latest_limit:c%2?17:0}));
  for(let s=0;s<2;s++)source.run(cid+s,cid,'https://youtube.com/@fixture'+c+s,s?'playlist':'author',s?0:12);
  for(let i=0;i<300;i++){
   const id=cid+'e'+i;episode.run(id,cid,id,'Episode '+i,i%9?i:null,i,'cache/'+id,i%2?'author':'playlist',JSON.stringify({description:'fixture '.repeat(200)}));
   if(i%13){member.run(cid+(i%2),id,1,i);if(i%7===0)member.run(cid+(1-i%2),id,2,i);}
  }
 }
 db.exec('COMMIT');
 return {db,env};
}

test('scoped window agrees with the global view for limits, overlaps, undated and legacy episodes',async()=>{
 const {db}=await fixture();
 try{
  db.exec("UPDATE episodes SET published_at=15 WHERE created_at%11=0;UPDATE sources SET paused=1 WHERE id='c00'");
  for(const cap of [0,1,2,100]){
   db.prepare("UPDATE sources SET latest_limit=? WHERE id='c00'").run(cap);
   for(const total of [0,2,100]){
    db.prepare("UPDATE channels SET settings=? WHERE id='c0'").run(JSON.stringify({latest_limit:total}));
    const expected=db.prepare("SELECT id FROM active_episode_window WHERE channel_id='c0' ORDER BY id").all();
    const actual=db.prepare(windowCte('id=?')+' SELECT id FROM scoped_window ORDER BY id').all('c0');
    assert.deepEqual(actual,expected);
   }
  }
  const owner=db.prepare(windowCte('user_id=?')+' SELECT id FROM scoped_window ORDER BY id').all('u');
  assert.deepEqual(owner,db.prepare("SELECT w.id FROM active_episode_window w JOIN channels c ON c.id=w.channel_id WHERE c.user_id='u' ORDER BY w.id").all());
  db.exec("UPDATE channels SET settings='{}';UPDATE users SET settings='{\"latest_limit\":3}' WHERE id='u'");
  assert.deepEqual(db.prepare(windowCte('user_id=?')+' SELECT id FROM scoped_window ORDER BY id').all('u'),db.prepare("SELECT w.id FROM active_episode_window w JOIN channels c ON c.id=w.channel_id WHERE c.user_id='u' ORDER BY w.id").all());
 }finally{db.close();}
});

test('page queries keep pagination, search and dashboard compatibility with large unrelated libraries',async()=>{
 const {db,env}=await fixture();
 try{
  const channel=db.prepare("SELECT * FROM channel_preferences WHERE id='c0'").get();
  const get=path=>channelDetail(env,channel,new URL('http://localhost/'+path));
  const first=await get('');assert.equal(first.episodes.length,30);
  const beyond=await get('?offset=99999');assert.equal(beyond.page.hasMore,false);assert.ok(beyond.episodes.length);
  const search=await get('?q=Episode%20299');assert.equal(search.episodes.length,1);
  const archived=await get('?tab=archive');assert.ok(archived.page.total>0);
  const token='a'.repeat(64);db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(await hash(token),'u',9999999999);
  const api=async path=>{const response=await worker.fetch(new Request('http://localhost'+path,{headers:{Cookie:'session='+token}}),env);assert.equal(response.status,200);return response.json();};
  const full=await api('/api/dashboard'),summary=await api('/api/dashboard?summary=1');
  assert.equal(full.episodes.length,100);assert.equal(summary.episodes.length,0);assert.deepEqual(summary.channels,full.channels);
  for(const c of full.channels){
   const expected=db.prepare('SELECT COUNT(*) n FROM episodes WHERE channel_id=? AND object_key IS NOT NULL AND id IN(SELECT id FROM active_episode_window)').get(c.id).n;
   assert.equal(c.episode_count,expected);assert.equal(c.archived_count,300-expected);
  }
  assert.ok(full.episodes.every(e=>['c0','c1','c2','c3'].includes(e.channel_id)));
  const collection=await api('/api/episodes?offset=99999');assert.equal(collection.episodes.length>0,true);
  assert.ok(JSON.stringify(summary).length<JSON.stringify(full).length/4);
  if(process.env.PAGE_BENCHMARK==='1'){
  const baseline=execFileSync('git',['show','fe2141f:src/channel-detail.js'],{encoding:'utf8'}).replaceAll("'./lib.js'",JSON.stringify(new URL('../src/lib.js',import.meta.url).href)).replaceAll("'./sorting.js'",JSON.stringify(new URL('../src/sorting.js',import.meta.url).href)).replaceAll("'./listing.js'",JSON.stringify(new URL('../src/listing.js',import.meta.url).href));
  const old=await import('data:text/javascript;base64,'+Buffer.from(baseline).toString('base64'));
  const measure=async fn=>{const start=performance.now();const value=await fn(env,channel,new URL('http://localhost/'));return {ms:performance.now()-start,value};};
  const before=await measure(old.channelDetail),after=await measure(channelDetail);
  assert.deepEqual(after.value,before.value);
  console.log(JSON.stringify({fixtureEpisodes:6000,channelEpisodes:300,beforeMs:Math.round(before.ms),afterMs:Math.round(after.ms),fullBytes:JSON.stringify(full).length,summaryBytes:JSON.stringify(summary).length}));
  }
 }finally{db.close();}
});
