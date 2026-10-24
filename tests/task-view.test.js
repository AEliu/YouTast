import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {channelDetail} from '../src/channel-detail.js';
import {userCollection} from '../src/listing.js';
import {renderChannelDetail} from '../public/channel-detail.js';
import {renderCollection,channelRoute,listRoute} from '../public/list-ui.js';

test('current tasks exclude completed and intentional stops; history, counts, search and paging agree',async()=>{
 const db=new DatabaseSync(':memory:');
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v);},execute(){return {results:db.prepare(sql).all(...values)};}});
 const env={DB:{prepare:statement,async batch(statements){return statements.map(s=>s.execute());}}};
 try{
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  db.exec("INSERT INTO users(id,username,salt,password_hash,created_at) VALUES('u','fixture','salt','hash',0),('v','other','salt','hash',0);INSERT INTO channels(id,user_id,title,feed_token,created_at) VALUES('c','u','Task fixture','feed',0),('d','v','Other','private',0)");
  const insert=db.prepare("INSERT INTO jobs(id,user_id,channel_id,kind,status,error,available_at,created_at,updated_at) VALUES(?,?,?,'scan',?,?,0,?,0)");
  const stops=['不在最新节目范围，暂不转换','来源已暂停','音频已由用户删除','音频保留期已到，已自动清理','空间不足，旧音频已自动清理'];
  for(let i=0;i<40;i++)insert.run('done'+i,'u','c','done','stale error',i);
  for(let i=0;i<stops.length;i++)insert.run('stop'+i,'u','c','failed',stops[i],100+i);
  for(const status of ['queued','running','failed'])insert.run(status,'u','c',status,status==='failed'?'YouTube unavailable':null,200);
  insert.run('private','v','d','failed','Other error',300);
  const channel=db.prepare("SELECT * FROM channel_preferences WHERE id='c'").get();
  const detail=params=>channelDetail(env,channel,new URL('http://localhost/?tab=jobs&'+params));
  const collection=params=>userCollection(env,{id:'u'},new URL('http://localhost/?'+params),'jobs');
  const current=await detail('offset=999');
  assert.deepEqual(current.counts,{episodes:0,ready:0,archived:0,jobs:3,history:45,queued:1,running:1,failed:1,active:2});
  assert.equal(current.page.offset,0);assert.equal(current.page.total,3);
  assert.deepEqual(new Set(current.jobs.map(j=>j.id)),new Set(['queued','running','failed']));
  const history=await detail('tasks=history&offset=999');assert.deepEqual(history.page,{offset:30,limit:30,total:45,hasMore:false});
  const first=await detail('tasks=history');
  assert.equal(first.jobs.filter(j=>j.display_status==='stopped').length,5);
  assert.ok(first.jobs.filter(j=>j.status==='done').every(j=>j.error===null));
  assert.equal((await detail('q=missing')).page.total,0);
  assert.equal((await detail('tasks=history&q=Task')).page.total,45);
  for(const tasks of ['current','history']){
   const global=await collection('tasks='+tasks+'&offset=999');
   const local=await detail('tasks='+tasks+'&offset=999');
   assert.deepEqual(global.page,local.page);assert.deepEqual(global.jobs.map(j=>j.id),local.jobs.map(j=>j.id));
   assert.equal(global.counts.jobs,3);assert.ok(global.jobs.every(j=>j.channel_id==='c'));
  }
  await assert.rejects(detail('tasks=invalid'));await assert.rejects(collection('tasks=invalid'));
  const options={escape:String,sortNames:{},statusNames:{queued:'等待处理',running:'处理中',failed:'失败',done:'已完成',stopped:'已停止'}};
  const html=renderChannelDetail(first,options);
  assert.match(html,/处理任务 3/);assert.match(html,/历史记录 45/);assert.match(html,/已停止/);assert.doesNotMatch(html,/data-action="retry"/);
  const globalHtml=renderCollection(await collection('tasks=history'),'jobs',{...options,channels:[channel]});
  assert.match(globalHtml,/tasks=history/);assert.doesNotMatch(globalHtml,/data-action="retry"/);
  db.exec("UPDATE jobs SET status='done' WHERE channel_id='c' AND status IN('queued','running');UPDATE jobs SET status='queued',error=NULL WHERE id='failed'");
  assert.equal((await detail('')).counts.failed,0);assert.equal((await detail('')).counts.jobs,1);
  db.exec("UPDATE jobs SET status='done' WHERE id='failed'");
  const empty=await detail('offset=999');assert.equal(empty.counts.jobs,0);assert.equal(empty.page.offset,0);assert.equal(empty.jobs.length,0);
  assert.match(renderChannelDetail(empty,options),/当前没有待处理、处理中或失败/);
 }finally{db.close();}
});

test('history routes preserve search and page while non-job links drop task filtering',()=>{
 assert.equal(listRoute('jobs',30,'hello world','history'),'#jobs/30?q=hello%20world&tasks=history');
 assert.equal(channelRoute('c','jobs',30,'测试','history'),'#channel/c/jobs/30?q=%E6%B5%8B%E8%AF%95&tasks=history');
 assert.equal(channelRoute('c','episodes',0,'','history'),'#channel/c/episodes/0');
});
