import {fetchWithDiscovery as fetch} from './discovery-fixture.mjs';
// Local-only detail pagination/privacy fixture. No YouTube or production writes.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin=process.env.TEST_ORIGIN||'http://127.0.0.1:8787',suffix=randomBytes(4).toString('hex'),keep=process.argv.includes('--keep');
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/,'Detail fixtures must only use a local test server');
let cookie='',a,b,passed=false;const accounts=[],account={username:'detail_'+suffix,password:randomBytes(24).toString('hex')};
const sql=localDatabase(origin);
async function api(path,data,status=200,auth=cookie){const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,Cookie:auth,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});assert.equal(r.status,status,`${path}: ${r.status}`);return {r,body:await r.json()};}
const q=x=>"'"+String(x).replaceAll("'","''")+"'";
try{
 await mkdir('test-results',{recursive:true});
 const user=await api('/api/auth/register',{...account,invite:'local-integration-invite-only'});cookie=user.r.headers.get('set-cookie').split(';')[0];
 accounts.push({id:user.body.user.id,username:account.username});
 if(process.env.TEST_FAIL_AFTER_REGISTER==='1')throw new Error('Intentional fixture cleanup verification');
 a=(await api('/api/channels',{title:'频道详情验证',description:'把节目、来源和处理进度放在一起。'},201)).body.id;
 b=(await api('/api/channels',{title:'Other channel'},201)).body.id;
 const rows=[];
 for(let i=0;i<152;i++){
  const own=i<32,cid=own?a:b,id=`detail_${suffix}_${i}`,title=own?`第 ${String(i+1).padStart(2,'0')} 集 · 示例节目`:`Other ${i}`;
  const meta=JSON.stringify({author:'示例作者',description:'频道内独立分页，顺序跟随该频道的设置。',chapters:[{startTime:0,title:'开场'},{startTime:30,title:'主题'}]});
  rows.push(`(${q(id)},${q(cid)},${q(('video'+String(i).padStart(6,'0')))},${q(title)},60,${own?1000+i:2000+i},${i===0?'NULL':1700000000+i},1,'author',${i+1},${i+1},${q(meta)})`);
 }
 await sql('INSERT INTO episodes(id,channel_id,video_id,title,duration,created_at,published_at,source_order,source_kind,source_position,added_position,metadata) VALUES '+rows.join(','));
 const dashboard=(await api('/api/dashboard')).body;assert.equal(dashboard.episodes.length,100);assert.ok(dashboard.episodes.every(e=>e.channel_id===b));
 let detail=(await api(`/api/channels/${a}/detail`)).body;
 assert.equal(detail.channel.id,a);assert.equal(detail.page.total,32);assert.equal(detail.episodes.length,30);assert.equal(detail.page.hasMore,true);
 const second=(await api(`/api/channels/${a}/detail?offset=30`)).body;assert.equal(second.episodes.length,2);assert.equal(new Set([...detail.episodes,...second.episodes].map(e=>e.id)).size,32);
 const beyond=(await api(`/api/channels/${a}/detail?offset=1000000`)).body;
 assert.deepEqual(beyond.page,{offset:30,limit:30,total:32,hasMore:false});
 assert.deepEqual(beyond.episodes.map(e=>e.id),second.episodes.map(e=>e.id));
 const atEnd=(await api(`/api/channels/${a}/detail?offset=32`)).body;assert.equal(atEnd.page.offset,30);assert.equal(atEnd.episodes.length,2);
 const unaligned=(await api(`/api/channels/${a}/detail?offset=31`)).body;assert.equal(unaligned.page.offset,31);assert.equal(unaligned.episodes.length,1);
 for(const tab of ['archive','jobs','sources']){
  const empty=(await api(`/api/channels/${a}/detail?tab=${tab}&offset=999`)).body;
  assert.equal(empty.page.offset,0);assert.equal(empty.page.total,0);
 }
 await api(`/api/channels/${a}/sort`,{sort_mode:'published_desc'});
 detail=(await api(`/api/channels/${a}/detail`)).body;assert.ok(detail.episodes[0].title.startsWith('第 32 集'));
 for(const offset of ['-1','1.5','1000001','NaN','9007199254740992'])await api(`/api/channels/${a}/detail?offset=${offset}`,null,400);
 await api(`/api/channels/${a}/detail?tab=invalid`,null,400);
 await api(`/api/channels/${a}/detail`,null,401,'');
 const stranger=await api('/api/auth/register',{username:'stranger_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});
 accounts.push({id:stranger.body.user.id,username:'stranger_'+suffix});
 await api(`/api/channels/${a}/detail`,null,404,stranger.r.headers.get('set-cookie').split(';')[0]);
 await sql(`UPDATE episodes SET object_key=${q(user.body.user.id+'/fixture/old.mp3')},size=10 WHERE id=${q('detail_'+suffix+'_0')}`);
 const settings={title:'频道详情验证',description:'把节目、来源和处理进度放在一起。',settings:{latest_limit:2},rss_metadata:{author:'',image:'',language:'inherit',category:'Education',explicit:false}};
 await api(`/api/channels/${a}/settings`,settings);
 detail=(await api(`/api/channels/${a}/detail`)).body;assert.equal(detail.page.total,2);assert.equal(detail.counts.archived,1);
 assert.equal((await api('/api/episodes')).body.page.total,122,'Global paging must respect each channel latest-N window');
 const smallerWindow=(await api(`/api/channels/${a}/detail?offset=30`)).body;assert.equal(smallerWindow.page.offset,0);assert.equal(smallerWindow.episodes.length,2);
 const archive=(await api(`/api/channels/${a}/detail?tab=archive`)).body;assert.equal(archive.episodes.length,1);assert.ok(archive.episodes[0].title.startsWith('第 01 集'));
 // A real delete on the only item of the archive's last page must fall back.
 settings.settings={latest_limit:1};await api(`/api/channels/${a}/settings`,settings);
 await sql(`UPDATE episodes SET object_key=${q(user.body.user.id+'/fixture/')}||id||'.m4a',size=10 WHERE channel_id=${q(a)} AND id!=${q('detail_'+suffix+'_31')}`);
 const lastArchive=(await api(`/api/channels/${a}/detail?tab=archive&offset=30`)).body;
 assert.equal(lastArchive.page.total,31);assert.equal(lastArchive.episodes.length,1);
 const runningId='detail_running_'+suffix,lastId=lastArchive.episodes[0].id;
 await sql(`INSERT INTO jobs(id,user_id,channel_id,episode_id,kind,status,available_at,created_at,updated_at) VALUES(${q(runningId)},${q(user.body.user.id)},${q(a)},${q(lastId)},'transcode','running',0,1000,1000)`);
 const blocked=await fetch(origin+'/api/episodes/'+lastId,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 assert.equal(blocked.status,409);
 assert.equal((await api(`/api/channels/${a}/detail?tab=archive&offset=30`)).body.episodes[0].id,lastId);
 await sql(`DELETE FROM jobs WHERE id=${q(runningId)}`);
 const deleted=await fetch(origin+'/api/episodes/'+lastArchive.episodes[0].id,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 assert.equal(deleted.status,200);
 const afterDelete=(await api(`/api/channels/${a}/detail?tab=archive&offset=30`)).body;
 assert.deepEqual(afterDelete.page,{offset:0,limit:30,total:30,hasMore:false});assert.equal(afterDelete.episodes.length,30);
 assert.ok(afterDelete.episodes.every(e=>e.id!==lastArchive.episodes[0].id));
 const finalArchiveId=afterDelete.episodes[0].id;
 await sql(`UPDATE episodes SET object_key=NULL,size=0 WHERE channel_id=${q(a)} AND id!=${q(finalArchiveId)}`);
 const finalDelete=await fetch(origin+'/api/episodes/'+finalArchiveId,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
 assert.equal(finalDelete.status,200);
 const deletedAll=(await api(`/api/channels/${a}/detail?tab=archive&offset=30`)).body;
 assert.deepEqual(deletedAll.page,{offset:0,limit:30,total:0,hasMore:false});assert.equal(deletedAll.episodes.length,0);
 // Jobs have their own total and can shrink independently of episode count.
 await sql(`DELETE FROM jobs WHERE channel_id=${q(a)}`);
 const jobRows=Array.from({length:31},(_,i)=>`(${q('detail_job_'+suffix+'_'+i)},${q(user.body.user.id)},${q(a)},${q('detail_'+suffix+'_'+i)},'transcode','done',0,${1000+i},${1000+i})`);
 await sql('INSERT INTO jobs(id,user_id,channel_id,episode_id,kind,status,available_at,created_at,updated_at) VALUES '+jobRows.join(','));
 const lastJobs=(await api(`/api/channels/${a}/detail?tab=jobs&tasks=history&offset=999`)).body;
 assert.deepEqual(lastJobs.page,{offset:30,limit:30,total:31,hasMore:false});assert.equal(lastJobs.jobs.length,1);
 await sql(`DELETE FROM jobs WHERE id=${q(lastJobs.jobs[0].id)}`);
 const fewerJobs=(await api(`/api/channels/${a}/detail?tab=jobs&tasks=history&offset=30`)).body;
 assert.equal(fewerJobs.page.offset,0);assert.equal(fewerJobs.jobs.length,30);
 await sql(`DELETE FROM jobs WHERE channel_id=${q(a)}`);
 settings.settings={};await api(`/api/channels/${a}/settings`,settings);
 await sql(`UPDATE episodes SET object_key=NULL,size=0 WHERE channel_id=${q(a)}`);
 const emptyArchive=(await api(`/api/channels/${a}/detail?tab=archive&offset=30`)).body;
 assert.deepEqual(emptyArchive.page,{offset:0,limit:30,total:0,hasMore:false});assert.equal(emptyArchive.episodes.length,0);
 await sql(`DELETE FROM episodes WHERE channel_id=${q(b)} AND id NOT IN(SELECT id FROM episodes WHERE channel_id=${q(b)} ORDER BY id LIMIT 30)`);
 const exactPage=(await api(`/api/channels/${b}/detail?offset=30`)).body;
 assert.deepEqual(exactPage.page,{offset:0,limit:30,total:30,hasMore:false});assert.equal(exactPage.episodes.length,30);
 await sql(`DELETE FROM episodes WHERE channel_id=${q(b)}`);
 const emptyChannel=(await api(`/api/channels/${b}/detail?offset=30`)).body;
 assert.deepEqual(emptyChannel.page,{offset:0,limit:30,total:0,hasMore:false});assert.equal(emptyChannel.episodes.length,0);
 if(keep)await writeFile('test-results/channel-detail-ui-user.json',JSON.stringify({...account,channel_id:a,other_channel_id:b}));
 console.log('PASS: channel-scoped pagination, out-of-range recovery, sort, latest window/archive separation, validation and access isolation');
 passed=true;
}finally{
 if(!keep||!passed){
  try{for(const cid of [a,b].filter(Boolean))await fetch(origin+'/api/channels/'+cid,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});}
  finally{await cleanupLocalUsers({origin,sql,accounts});}
 }
}
