// Local-only detail pagination/privacy fixture. No YouTube or production writes.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {writeFile,unlink} from 'node:fs/promises';
const origin='http://127.0.0.1:8787',suffix=randomBytes(4).toString('hex'),keep=process.argv.includes('--keep');
let cookie='',a,b;const account={username:'detail_'+suffix,password:randomBytes(24).toString('hex')};
async function sql(command){
 const file=resolve(`test-results/channel-detail-${suffix}.sql`);await writeFile(file,command);
 try{await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local','--file',file],{windowsHide:true});}
 finally{await unlink(file);}
}
async function api(path,data,status=200,auth=cookie){const r=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,Cookie:auth,'Content-Type':'application/json'},body:data?JSON.stringify(data):undefined});assert.equal(r.status,status,`${path}: ${r.status}`);return {r,body:await r.json()};}
const q=x=>"'"+String(x).replaceAll("'","''")+"'";
try{
 await sql('DELETE FROM login_limits');
 const user=await api('/api/auth/register',{...account,invite:'local-integration-invite-only'});cookie=user.r.headers.get('set-cookie').split(';')[0];
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
 await api(`/api/channels/${a}/sort`,{sort_mode:'published_desc'});
 detail=(await api(`/api/channels/${a}/detail`)).body;assert.ok(detail.episodes[0].title.startsWith('第 32 集'));
 await api(`/api/channels/${a}/detail?offset=-1`,null,400);await api(`/api/channels/${a}/detail?offset=1.5`,null,400);await api(`/api/channels/${a}/detail?tab=invalid`,null,400);
 await api(`/api/channels/${a}/detail`,null,401,'');
 const stranger=await api('/api/auth/register',{username:'stranger_'+suffix,password:randomBytes(24).toString('hex'),invite:'local-integration-invite-only'});
 await api(`/api/channels/${a}/detail`,null,404,stranger.r.headers.get('set-cookie').split(';')[0]);
 await sql(`UPDATE episodes SET object_key=${q(user.body.user.id+'/fixture/old.mp3')},size=10 WHERE id=${q('detail_'+suffix+'_0')}`);
 const settings={title:'频道详情验证',description:'把节目、来源和处理进度放在一起。',settings:{latest_limit:2},rss_metadata:{author:'',image:'',language:'inherit',category:'Education',explicit:false}};
 await api(`/api/channels/${a}/settings`,settings);
 detail=(await api(`/api/channels/${a}/detail`)).body;assert.equal(detail.page.total,2);assert.equal(detail.counts.archived,1);
 const archive=(await api(`/api/channels/${a}/detail?tab=archive`)).body;assert.equal(archive.episodes.length,1);assert.ok(archive.episodes[0].title.startsWith('第 01 集'));
 settings.settings={};await api(`/api/channels/${a}/settings`,settings);
 await sql(`UPDATE episodes SET object_key=NULL,size=0 WHERE channel_id=${q(a)}`);
 if(keep)await writeFile('test-results/channel-detail-ui-user.json',JSON.stringify({...account,channel_id:a,other_channel_id:b}));
 console.log('PASS: channel-scoped 32-item pagination beyond global 100, channel sort, latest window/archive separation, validation, anonymous and cross-user isolation');
}finally{
 if(!keep)for(const cid of [a,b].filter(Boolean))await fetch(origin+'/api/channels/'+cid,{method:'DELETE',headers:{Origin:origin,Cookie:cookie}});
}
