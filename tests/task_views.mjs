// Local D1/API contract. No upstream requests or media objects.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile,mkdir} from 'node:fs/promises';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8801',sql=localDatabase(origin);
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
const accounts=[],suffix=randomBytes(5).toString('hex'),keep=process.argv.includes('--keep');
let cookie='',passed=false,channel;
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
async function api(path,data,status=200,auth=cookie){
 const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,Cookie:auth,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 assert.equal(response.status,status,path);return {response,body:await response.json()};
}
try{
 const username='taskview_'+suffix,password='local-task-view-fixture-password';
 const registered=await api('/api/auth/register',{username,password,invite:'local-integration-invite-only'});
 const user={id:registered.body.user.id,username};accounts.push(user);cookie=registered.response.headers.get('set-cookie').split(';')[0];
 channel=(await api('/api/channels',{title:'Task view fixture'},201)).body.id;
 const rows=[],ids={};
 for(let i=0;i<43;i++){
  const id='task_'+suffix+'_'+i;let status='done',error=null;
  if(i<3){status=['queued','running','failed'][i];ids[status]=id;if(status==='failed')error='Genuine conversion failure';}
  if(i>=38){status='failed';error=['不在最新节目范围，暂不转换','来源已暂停','音频已由用户删除','音频保留期已到，已自动清理','空间不足，旧音频已自动清理'][i-38];}
  rows.push(`(${q(id)},${q(user.id)},${q(channel)},'scan',${q(status)},${error?q(error):'NULL'},0,${100+i},100)`);
 }
 await sql('INSERT INTO jobs(id,user_id,channel_id,kind,status,error,available_at,created_at,updated_at) VALUES '+rows.join(','));
 const detail=async params=>(await api(`/api/channels/${channel}/detail?tab=jobs&${params}`)).body;
 let current=await detail('offset=999');assert.equal(current.counts.jobs,3);assert.equal(current.counts.failed,1);assert.equal(current.counts.history,40);assert.equal(current.page.total,3);assert.equal(current.page.offset,0);
 assert.deepEqual(new Set(current.jobs.map(j=>j.id)),new Set(Object.values(ids)));
 const history=await detail('tasks=history&offset=999');assert.deepEqual(history.page,{offset:30,limit:30,total:40,hasMore:false});
 const first=await detail('tasks=history');assert.equal(first.jobs.filter(j=>j.display_status==='stopped').length,5);
 assert.equal((await api('/api/jobs?offset=999')).body.page.total,3);
 assert.equal((await api('/api/jobs?tasks=history&offset=999')).body.page.offset,30);
 assert.equal((await api('/api/jobs?tasks=history&q=Task%20view')).body.page.total,40);
 assert.equal((await detail('tasks=history&q=Task%20view')).page.total,40);
 assert.equal((await detail('q=missing')).page.total,0);
 for(const path of ['/api/jobs?tasks=invalid',`/api/channels/${channel}/detail?tab=jobs&tasks=invalid`])await api(path,null,400);
 await api('/api/jobs',null,401,'');
 const strangerName='taskother_'+suffix;
 const stranger=await api('/api/auth/register',{username:strangerName,password,invite:'local-integration-invite-only'});accounts.push({id:stranger.body.user.id,username:strangerName});
 const strangerCookie=stranger.response.headers.get('set-cookie').split(';')[0];
 assert.equal((await api('/api/jobs?tasks=history',null,200,strangerCookie)).body.page.total,0);
 await api(`/api/channels/${channel}/detail?tab=jobs&tasks=history`,null,404,strangerCookie);
 await api(`/api/jobs/${ids.failed}/retry`,{},200,strangerCookie);assert.equal((await detail('')).counts.failed,1);
 await api(`/api/jobs/${ids.failed}/retry`,{});current=await detail('');assert.equal(current.counts.failed,0);assert.equal(current.counts.queued,2);assert.equal(current.counts.jobs,3);
 await sql(`UPDATE jobs SET status='done',error=NULL WHERE channel_id=${q(channel)} AND status IN('queued','running')`);
 const empty=await detail('offset=999');assert.equal(empty.counts.jobs,0);assert.equal(empty.page.total,0);assert.equal(empty.page.offset,0);assert.equal(empty.counts.history,43);
 if(keep){
  await sql(`UPDATE jobs SET status='queued' WHERE id=${q(ids.queued)};UPDATE jobs SET status='running' WHERE id=${q(ids.running)};UPDATE jobs SET status='failed',error='Genuine conversion failure' WHERE id=${q(ids.failed)}`);
  await mkdir('test-results',{recursive:true});await writeFile('test-results/task-view-ui.json',JSON.stringify({origin,username,password,channel,accounts,ids}));
 }
 passed=true;console.log('PASS: current/history counts, five intentional stops, search/paging, retry, completion to zero, validation and owner isolation');
}finally{
 if(!keep||!passed){
  if(channel)await fetch(origin+'/api/channels/'+channel,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
  await cleanupLocalUsers({origin,sql,accounts});
 }
}
