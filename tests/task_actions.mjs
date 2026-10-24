import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8802',sql=localDatabase(origin);
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
const suffix=randomBytes(5).toString('hex'),accounts=[],keep=process.argv.includes('--keep');
let cookie='',passed=false,channel;
const q=s=>"'"+String(s).replaceAll("'","''")+"'";
async function api(path,data,status=200,auth=cookie,requestOrigin=origin){
 const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:requestOrigin,Cookie:auth,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 const body=await response.json();assert.equal(response.status,status,`${path}: ${body.error||''}`);return {body,response};
}
try{
 const username='bulk_'+suffix,password='local-bulk-task-fixture-password';
 const r=await api('/api/auth/register',{username,password,invite:'local-integration-invite-only'});
 const owner={id:r.body.user.id,username};accounts.push(owner);cookie=r.response.headers.get('set-cookie').split(';')[0];
 channel=(await api('/api/channels',{title:'Bulk task fixture'},201)).body.id;
 const other=(await api('/api/channels',{title:'Other scope'},201)).body.id;
 const episodes=[],jobs=[],ids=[];
 for(let i=0;i<38;i++){
  const id='bulk_'+suffix+'_'+i,cid=i<36?channel:other;ids.push(id);
  episodes.push(`(${q(id)},${q(cid)},${q(id)},${q(i<32?'Match '+i:'Other '+i)},1)`);
  jobs.push(`(${q(id)},${q(owner.id)},${q(cid)},${q(id)},'transcode',${q(i===35?'running':'failed')},'Fixture failure',3,0,${i},0)`);
 }
 await sql('INSERT INTO episodes(id,channel_id,video_id,title,created_at) VALUES '+episodes.join(',')+';INSERT INTO jobs(id,user_id,channel_id,episode_id,kind,status,error,attempts,available_at,created_at,updated_at) VALUES '+jobs.join(','));
 const scope={channel_id:channel,query:'Match'},selection={action:'retry',ids:ids.slice(0,2),...scope};
 const preview=async input=>(await api('/api/jobs/bulk/preview',input)).body;
 const apply=async input=>{const p=await preview(input);assert.ok(p.count>0);return (await api('/api/jobs/bulk',{...input,expected_count:p.count,expected_matched:p.matched})).body;};
 assert.equal((await preview({action:'dismiss',all:true,...scope})).count,32);
 assert.equal((await apply(selection)).changed,2);
 const detail=async params=>(await api(`/api/channels/${channel}/detail?tab=jobs&${params}`)).body;
 assert.equal((await detail('q=Match')).failedTotal,30);
 await api('/api/jobs/bulk/preview',{action:'dismiss',all:true},401,'');
 await api('/api/jobs/bulk/preview',{action:'dismiss',all:true},403,cookie,'https://invalid.example');
 await api('/api/jobs/bulk/preview',{action:'dismiss'},400);
 const strangerName='bulkother_'+suffix,s=await api('/api/auth/register',{username:strangerName,password,invite:'local-integration-invite-only'});
 accounts.push({id:s.body.user.id,username:strangerName});const strangerCookie=s.response.headers.get('set-cookie').split(';')[0];
 assert.equal((await api('/api/jobs/bulk/preview',{action:'dismiss',ids:[ids[2]]},200,strangerCookie)).body.count,0);
 await api('/api/jobs/bulk/preview',{action:'dismiss',all:true,...scope},404,strangerCookie);
 const race={action:'dismiss',ids:[ids[2],ids[3]],...scope},p=await preview(race);
 await sql(`UPDATE jobs SET status='running' WHERE id=${q(ids[3])}`);
 await api('/api/jobs/bulk',{...race,expected_count:p.count,expected_matched:p.matched},409);
 assert.equal((await preview({action:'dismiss',ids:[ids[2]]})).count,1);
 await sql(`UPDATE jobs SET status='failed' WHERE id=${q(ids[3])}`);
 assert.equal((await apply({action:'dismiss',all:true,...scope})).changed,30);
 assert.equal((await detail('q=Match')).failedTotal,0);assert.equal((await detail('q=Match')).page.total,2);
 assert.equal((await api('/api/jobs?q=Other')).body.failedTotal,5,'Other search matches and channels are retained');
 const episodeBefore=JSON.stringify((await sql(`SELECT * FROM episodes WHERE channel_id=${q(channel)} ORDER BY id`))[0].results);
 await api('/api/settings',{settings:{latest_limit:0}});
 assert.equal((await detail('q=Match')).page.total,2,'Reconciliation must not recreate cleared failures');
 assert.equal(JSON.stringify((await sql(`SELECT * FROM episodes WHERE channel_id=${q(channel)} ORDER BY id`))[0].results),episodeBefore);
 await api('/api/episodes/'+ids[2]+'/retry',{});assert.equal((await detail('q=Match')).page.total,3,'Explicit regeneration restores a cleared conversion');
 const source='dupsource_'+suffix,dups=['dupscan_'+suffix+'_1','dupscan_'+suffix+'_2'];
 await sql(`INSERT INTO sources(id,channel_id,url,kind,next_scan,created_at) VALUES(${q(source)},${q(channel)},'https://youtube.com/@local-bulk-fixture','author',9999999999,0);INSERT INTO jobs(id,user_id,channel_id,source_id,kind,status,error,available_at,created_at,updated_at) VALUES ${dups.map((id,i)=>`(${q(id)},${q(owner.id)},${q(channel)},${q(source)},'scan','failed','Fixture failure',0,${100+i},0)`).join(',')}`);
 const duplicates={action:'retry',ids:dups,channel_id:channel};
 assert.deepEqual(await preview(duplicates),{matched:2,count:1});assert.equal((await apply(duplicates)).changed,1);
 assert.deepEqual(await preview(duplicates),{matched:1,count:0},'The active source scan prevents a second queued scan');
 assert.equal((await apply({...duplicates,action:'dismiss'})).changed,1);
 if(keep){
  await sql(`UPDATE jobs SET status='failed',error='Fixture failure',dismissed_at=NULL WHERE channel_id=${q(channel)} AND id!=${q(ids[35])}`);
  await mkdir('test-results',{recursive:true});await writeFile('test-results/bulk-task-ui.json',JSON.stringify({origin,username,password,channel,accounts,ids}));
 }
 passed=true;console.log('PASS: scoped selected/all retry and clear, 32 matches across pages, count conflict, CSRF/auth/privacy, retained episodes, no auto-requeue and explicit regeneration');
}finally{
 if(!keep||!passed)await cleanupLocalUsers({origin,sql,accounts});
}
