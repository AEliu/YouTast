import {fetchWithDiscovery as fetch} from './discovery-fixture.mjs';
// Local-only collections/search/privacy contract; all accounts are exact-ID fixtures.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8793',sql=localDatabase(origin);
const suffix=randomBytes(5).toString('hex'),accounts=[],channels=[];
const keep=process.argv.includes('--keep');let cookie='',passed=false,owner;
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
async function api(path,data,expected=200,auth=cookie){
 const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,Cookie:auth,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});
 assert.equal(r.status,expected,`${path}: ${r.status}`);return {r,body:await r.json()};
}
async function register(label){
 const account={username:label+'_'+suffix,password:randomBytes(24).toString('hex')};
 const {r,body}=await api('/api/auth/register',{...account,invite:'local-integration-invite-only'});
 accounts.push({id:body.user.id,username:account.username});
 return {...account,id:body.user.id,cookie:r.headers.get('set-cookie').split(';')[0]};
}
try{
 owner=await register('browse');cookie=owner.cookie;
 const channel=(await api('/api/channels',{title:'Browse fixture'},201)).body.id;channels.push(channel);
 const outsider=await register('outside');
 const other=(await api('/api/channels',{title:'Private outside'},201,outsider.cookie)).body.id;
 const rows=[];
 for(let i=0;i<162;i++){
  const own=i<152,id=`browse_${suffix}_${i}`,title=i===0?'100%_literal':`Episode ${String(i).padStart(3,'0')}`;
  const meta=JSON.stringify({author:i<35?'播客作者':'Other author',description:'A description with Unicode 测试'});
  rows.push(`(${q(id)},${q(own?channel:other)},${q('browse'+String(i).padStart(5,'0'))},${q(title)},60,${1000+i},${1700000000+i},${q(meta)})`);
 }
 await sql('INSERT INTO episodes(id,channel_id,video_id,title,duration,created_at,published_at,metadata) VALUES '+rows.join(','));
 const jobs=Array.from({length:82},(_,i)=>`(${q('browse_job_'+suffix+'_'+i)},${q(owner.id)},${q(channel)},${q('browse_'+suffix+'_'+i)},'transcode','done',0,${1000+i},${1000+i})`);
 await sql('INSERT INTO jobs(id,user_id,channel_id,episode_id,kind,status,available_at,created_at,updated_at) VALUES '+jobs.join(','));
 assert.equal((await api('/api/dashboard')).body.episodes.length,100,'Legacy dashboard remains bounded');
 const ids=new Set();
 for(let offset=0;offset<152;offset+=30){
  const model=(await api('/api/episodes?offset='+offset)).body;
  assert.equal(model.page.total,152);assert.equal(model.page.offset,offset);
  assert.ok(model.episodes.every(e=>e.channel_id===channel));
  for(const e of model.episodes){assert.ok(!ids.has(e.id));ids.add(e.id);}
 }
 assert.equal(ids.size,152,'Every episode remains reachable beyond old 100-item cap');
 let model=(await api('/api/episodes?offset=1000000')).body;
 assert.deepEqual(model.page,{offset:150,limit:30,total:152,hasMore:false});assert.equal(model.episodes.length,2);
 model=(await api('/api/jobs?tasks=history&offset=999')).body;
 assert.deepEqual(model.page,{offset:60,limit:30,total:82,hasMore:false});assert.equal(model.jobs.length,22);
 assert.ok(model.jobs.every(j=>j.channel_id===channel&&!('lease_token' in j)&&!('executor_id' in j)));
 model=(await api('/api/episodes?q='+encodeURIComponent('播客作者')+'&offset=999')).body;
 assert.deepEqual(model.page,{offset:30,limit:30,total:35,hasMore:false});assert.equal(model.episodes.length,5);
 for(const term of ['%','_','100%_literal'])assert.equal((await api('/api/episodes?q='+encodeURIComponent(term))).body.page.total,1,'Search wildcard characters are literal');
 assert.equal((await api('/api/episodes?q='+encodeURIComponent("' OR 1=1 --"))).body.page.total,0);
 assert.equal((await api('/api/episodes?q='+encodeURIComponent('测试'))).body.page.total,152);
 assert.equal((await api('/api/jobs?tasks=history&q='+encodeURIComponent('Browse fixture'))).body.page.total,82);
 model=(await api(`/api/channels/${channel}/detail?q=${encodeURIComponent('播客作者')}&offset=999`)).body;
 assert.equal(model.counts.episodes,152);assert.deepEqual(model.page,{offset:30,limit:30,total:35,hasMore:false});
 assert.equal((await api(`/api/channels/${channel}/detail?q=not-found&offset=999`)).body.page.offset,0);
 assert.equal((await api(`/api/channels/${channel}/detail?q=not-found`)).body.page.total,0);
 assert.equal((await api(`/api/channels/${channel}/detail?tab=jobs&tasks=history&q=Episode`)).body.page.total,81);
 await api(`/api/channels/${other}/detail?q=Episode`,undefined,404);
 for(const path of ['/api/episodes','/api/jobs']){
  await api(path,undefined,401,'');
  for(const param of ['offset=-1','offset=1.5','offset=1000001','q='+'a'.repeat(201)])await api(path+'?'+param,undefined,400);
 }
 assert.equal((await api('/api/episodes',undefined,200,outsider.cookie)).body.page.total,10);
 await sql(`UPDATE episodes SET source_kind='author',source_order=1,source_position=created_at-999,published_at=CASE WHEN created_at=1000 THEN NULL ELSE published_at END WHERE channel_id=${q(channel)}`);
 const filteredOrder=(await api(`/api/channels/${channel}/detail?q=Episode`)).body;
 assert.equal(filteredOrder.episodes[0].id,'browse_'+suffix+'_151','Filtering out the missing-date row must preserve author fallback order');
 if(keep){
  await mkdir('test-results',{recursive:true});
  await writeFile('test-results/collections-ui-user.json',JSON.stringify({username:owner.username,password:owner.password,channel_id:channel,other_channel_id:other}));
 }
 passed=true;
 console.log('PASS: 152 episodes / 82 jobs, complete stable paging, overflow recovery, literal and Unicode search, channel scope, validation and privacy');
}finally{
 if(!keep||!passed){
  try{for(const id of channels)await fetch(origin+'/api/channels/'+id,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});}
  finally{await cleanupLocalUsers({origin,sql,accounts});}
 }
}
