// Exercise the bulk endpoint against local Wrangler D1/R2, not a mocked batch.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {localDatabase, cleanupLocalUsers} from './local-fixture.mjs';

const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8804';
const sql=localDatabase(origin,process.env.TEST_PERSIST_TO||'.wrangler/audio-actions-state');
const suffix=randomBytes(4).toString('hex'), accounts=[];
const q=value=>`'${String(value).replaceAll("'","''")}'`;
async function request(path,{cookie,data,status=200}={}) {
 const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:data?JSON.stringify(data):undefined});
 assert.equal(response.status,status,`${path}: ${await response.clone().text()}`);
 return response;
}
try {
 async function register(prefix){
  const response=await request('/api/auth/register',{data:{username:`${prefix}_${suffix}`,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'}});
  const body=await response.json();accounts.push(body.user);
  return {user:body.user,cookie:response.headers.get('set-cookie').split(';')[0]};
 }
 const owner=await register('audio_owner'), other=await register('audio_other');
 async function channel(account,title){return (await (await request('/api/channels',{cookie:account.cookie,data:{title},status:201})).json()).id;}
 const ownChannel=await channel(owner,'Bulk audio fixture'), otherChannel=await channel(other,'Other owner fixture');
 const selected=Array.from({length:77},()=>randomUUID()),shared=randomUUID(),busy=randomUUID(),foreign=randomUUID(),missing=randomUUID();
 const sharedKey=`${owner.user.id}/fixture-shared`;
 const episodes=[...selected,shared,busy].map((id,i)=>`(${q(id)},${q(ownChannel)},${q('v'+String(i).padStart(10,'0'))},'Fixture',1,${q(i===0||id===shared?sharedKey:`${owner.user.id}/${id}`)},10)`);
 episodes.push(`(${q(foreign)},${q(otherChannel)},'foreign0001','Other',1,${q(`${other.user.id}/foreign`)},10)`);
 await sql(`INSERT INTO episodes(id,channel_id,video_id,title,created_at,object_key,size) VALUES ${episodes.join(',')};
 INSERT INTO jobs(id,user_id,channel_id,episode_id,kind,status,available_at,created_at,updated_at) VALUES
 (${q(randomUUID())},${q(owner.user.id)},${q(ownChannel)},${q(selected[0])},'transcode','done',0,1,1),
 (${q(randomUUID())},${q(owner.user.id)},${q(ownChannel)},${q(busy)},'transcode','running',0,1,1);`);
 const result=await (await request('/api/episodes/bulk-delete',{cookie:owner.cookie,data:{ids:[...selected,busy,foreign,missing]}})).json();
 assert.deepEqual(result,{ok:true,changed:77,skipped:3});
 const rows=(await sql(`SELECT id,object_key,cleanup_reason FROM episodes WHERE id IN (${[selected[0],shared,busy,foreign].map(q).join(',')})`))[0].results;
 const byId=Object.fromEntries(rows.map(row=>[row.id,row]));
 assert.equal(byId[selected[0]].object_key,null);assert.equal(byId[selected[0]].cleanup_reason,'manual');
 assert.equal(byId[shared].object_key,sharedKey);assert.ok(byId[busy].object_key);assert.ok(byId[foreign].object_key);
 const jobs=(await sql(`SELECT status,error FROM jobs WHERE episode_id=${q(selected[0])}`))[0].results;
 assert.equal(jobs[0].status,'failed');assert.equal(jobs[0].error,'音频已由用户删除');
 assert.equal((await sql(`SELECT COUNT(*) AS n FROM object_gc WHERE object_key=${q(sharedKey)}`))[0].results[0].n,0);
 await request('/api/episodes/bulk-delete',{cookie:owner.cookie,data:{ids:Array.from({length:81},()=>randomUUID())},status:400});
 console.log('PASS: 80-item real D1 batch, owner isolation, running job, retained shared audio, job state and limit');
} finally {
 await cleanupLocalUsers({origin,sql,accounts});
}
