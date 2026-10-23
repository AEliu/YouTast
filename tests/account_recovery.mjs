// Offline operator recovery drill in a uniquely created disposable D1 state.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {secret,passwordHash} from '../src/lib.js';
import {localDatabase} from './local-fixture.mjs';
const suffix=randomBytes(5).toString('hex'),state=resolve(`.wrangler/recovery-contract-${suffix}`);
assert.ok(state.startsWith(resolve('.wrangler')+sep));
const sql=localDatabase('http://127.0.0.1:8795',state),outputs=[];let created=false;
const cli=resolve('scripts/recover-account.mjs');
async function run(args,success=true){
 try{
  const result=await promisify(execFile)(process.execPath,[cli,...args],{windowsHide:true,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  assert.ok(success,'Recovery should have rejected this request');return result;
 }catch(error){if(success||error.code===undefined)throw error;return {stdout:error.stdout||'',stderr:error.stderr||''};}
}
const user=(index,role='user',disabled=0)=>({id:randomUUID(),username:`recover_${suffix}_${index}`,salt:secret(),role,disabled});
const output=index=>{const file=resolve(`.secrets/recovery-contract-${suffix}-${index}.json`);outputs.push(file);return file;};
const flags=(account,file)=>['--local','--persist-to',state,'--username',account.username,'--confirm-reset',account.username,'--output',file];
const current=async account=>(await sql(`SELECT salt,password_hash,role,disabled,(SELECT COUNT(*) FROM sessions WHERE user_id=users.id) sessions FROM users WHERE id='${account.id}'`))[0].results[0];
try{
 await mkdir(state);created=true;
 await mkdir('.secrets',{recursive:true});
 await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','migrations','apply','DB','--local','--persist-to',state],{windowsHide:true,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
 const users=[user(0,'admin'),user(1,'user',1),user(2),user(3)];
 for(const account of users){
  account.oldHash=await passwordHash('local-recovery-original-password',account.salt);
  await sql(`INSERT INTO users(id,username,salt,password_hash,created_at,role,disabled) VALUES('${account.id}','${account.username}','${account.salt}','${account.oldHash}',1000,'${account.role}',${account.disabled}); INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('${secret()}','${account.id}',9999999999)`);
 }
 const file=output(0),normal=users[0];
 await run(['--local','--persist-to',state,'--username',normal.username,'--output',file],false);
 assert.equal((await current(normal)).password_hash,normal.oldHash);
 const logs=await run(flags(normal,file));
 const recovered=JSON.parse(await readFile(file,'utf8')),row=await current(normal);
 assert.equal(recovered.state,'complete');assert.equal(row.role,'admin');assert.equal(row.disabled,0);assert.equal(row.sessions,0);
 assert.ok(await passwordHash(recovered.password,row.salt)===row.password_hash);
 assert.ok(!(logs.stdout+logs.stderr).includes(recovered.password),'Recovery logs must not print the new password');
 await run([...flags(normal,file),'--resume'],false);
 for(const [index,alreadyApplied] of [[1,true],[2,false]]){
  const account=users[index],target=output(index),password=secret().slice(0,32);
  const plan={version:1,state:'pending',userId:account.id,username:account.username,password,previousSalt:account.salt,previousHash:account.oldHash,auditId:randomUUID(),createdAt:new Date().toISOString()};
  await writeFile(target,JSON.stringify(plan),{flag:'wx',mode:0o600});
  let appliedSalt;
  if(alreadyApplied){appliedSalt=secret();await sql(`UPDATE users SET salt='${appliedSalt}',password_hash='${await passwordHash(password,appliedSalt)}' WHERE id='${account.id}'`);}
  await run([...flags(account,target),'--resume']);
  const after=await current(account);assert.equal(after.sessions,0);assert.equal(after.disabled,account.disabled);
  assert.ok(await passwordHash(password,after.salt)===after.password_hash);
  if(alreadyApplied)assert.equal(after.salt,appliedSalt,'Resume must not change already-applied credentials');
 }
 const conflict=users[3],conflictFile=output(3),newSalt=secret(),newHash=await passwordHash('independent-user-password-change',newSalt);
 await writeFile(conflictFile,JSON.stringify({version:1,state:'pending',userId:conflict.id,username:conflict.username,password:secret().slice(0,32),previousSalt:conflict.salt,previousHash:conflict.oldHash,auditId:randomUUID()}),{flag:'wx',mode:0o600});
 await sql(`UPDATE users SET salt='${newSalt}',password_hash='${newHash}' WHERE id='${conflict.id}'`);
 await run([...flags(conflict,conflictFile),'--resume'],false);
 assert.equal((await current(conflict)).password_hash,newHash,'Resume must not overwrite an independent password change');
 assert.equal(JSON.parse(await readFile(conflictFile,'utf8')).state,'pending');
 const audit=(await sql('SELECT action,details FROM admin_audit'))[0].results;
 assert.equal(audit.filter(a=>a.action==='user.password.recovery').length,3);
 assert.ok(!JSON.stringify(audit).includes(recovered.password));
 console.log('PASS: operator recovery, required confirmation, last-admin/disabled state, web-session revocation, private output, interruption resumption and concurrent-change refusal; disposable state removed');
}finally{
 for(const file of outputs)await rm(file,{force:true});
 if(created){assert.ok(state.startsWith(resolve('.wrangler')+sep));await rm(state,{recursive:true,force:true});}
}
