// Operator recovery for a lost last-admin password. No plaintext on stdout.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,open,readFile,writeFile,unlink,realpath,rename} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {secret,passwordHash} from '../src/lib.js';

class RecoveryError extends Error {}
const args=process.argv.slice(2),options={};
function parseOptions(){
 if(args.includes('--help')){console.log('Usage: node scripts/recover-account.mjs (--local [--persist-to DIR] | --remote) --username NAME --confirm-reset NAME [--output .secrets/FILE.json] [--resume]');process.exit(0);}
 for(let i=0;i<args.length;i++){
 const key=args[i];
 if(['--local','--remote','--resume'].includes(key)){if(options[key])throw new RecoveryError('Duplicate option');options[key]=true;}
 else if(['--username','--confirm-reset','--output','--persist-to'].includes(key)){if(options[key]||!args[i+1]||args[i+1].startsWith('--'))throw new RecoveryError('Invalid option value');options[key]=args[++i];}
 else throw new RecoveryError('Unknown recovery option');
 }
}
let temporary;
async function sql(command,read=false){
 const scope=[options['--local']?'--local':'--remote',...(options['--persist-to']?['--persist-to',options['--persist-to']]:[])];
 let file;
 if(!read){
  await mkdir('.wrangler/account-recovery',{recursive:true});
  file=resolve(`.wrangler/account-recovery/${randomUUID()}.sql`);temporary=file;
  await writeFile(file,command);
 }
 try{
  const {stdout}=await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB',...scope,...(read?['--command',command]:['--file',file]),'--json','--yes'],{windowsHide:true,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
  // Remote --file uses the import API and returns progress text. Only a
  // separate read-only --command query is used as confirmation evidence.
  return read?JSON.parse(stdout):undefined;
 }finally{if(file){await unlink(file);temporary=undefined;}}
}
async function main(){
 parseOptions();
 if(Boolean(options['--local'])===Boolean(options['--remote']))throw new RecoveryError('Choose exactly one of --local or --remote');
 const username=options['--username'];
 if(!/^[a-z0-9_-]{3,40}$/.test(username||'')||options['--confirm-reset']!==username)throw new RecoveryError('Provide a lowercase username and matching --confirm-reset username');
 if(options['--remote']&&options['--persist-to'])throw new RecoveryError('--persist-to is local-only');
 await mkdir('.secrets',{recursive:true});
 const output=resolve(options['--output']||`.secrets/recovery-${username}.json`);
 if(await realpath(dirname(output))!==await realpath('.secrets')||!basename(output).endsWith('.json'))throw new RecoveryError('Recovery output must be a JSON file directly inside .secrets');
 const rows=await sql(`SELECT id,username,salt,password_hash,role,disabled FROM users WHERE username='${username}'`,true);
 const user=rows[0].results[0];if(!user)throw new RecoveryError('Account not found');
 if(!/^[a-f0-9-]{36}$/.test(user.id)||!/^[a-f0-9]{64}$/.test(user.salt)||!/^[a-f0-9]{64}$/.test(user.password_hash))throw new RecoveryError('Account credential format needs manual inspection');
 let plan;
 if(options['--resume']){
  plan=JSON.parse(await readFile(output,'utf8'));
  if(plan.version!==1||plan.state!=='pending'||plan.userId!==user.id||plan.username!==username||!/^[a-f0-9]{32}$/.test(plan.password)||!/^[a-f0-9-]{36}$/.test(plan.auditId)||!/^[a-f0-9]{64}$/.test(plan.previousSalt)||!/^[a-f0-9]{64}$/.test(plan.previousHash))throw new RecoveryError('Recovery plan does not match this pending account recovery');
 }else{
  plan={version:1,state:'pending',userId:user.id,username,password:secret().slice(0,32),previousSalt:user.salt,previousHash:user.password_hash,auditId:randomUUID(),createdAt:new Date().toISOString()};
  const file=await open(output,'wx',0o600);
  try{await file.writeFile(JSON.stringify(plan,null,2)+'\n');await file.sync();}finally{await file.close();}
 }
 let salt=user.salt,encoded=await passwordHash(plan.password,salt);
 const alreadyApplied=encoded===user.password_hash;
 if(!alreadyApplied&&(user.salt!==plan.previousSalt||user.password_hash!==plan.previousHash))throw new RecoveryError('Account credentials changed after the recovery plan was created; refusing to overwrite them');
 if(!alreadyApplied){salt=secret();encoded=await passwordHash(plan.password,salt);}
 // Every interpolated credential is fixed-format hex, and usernames were
 // validated above. The commit guard also protects resumptions and races.
 const applied=`EXISTS(SELECT 1 FROM users WHERE id='${user.id}' AND salt='${salt}' AND password_hash='${encoded}')`;
 const change=alreadyApplied?'':`UPDATE users SET salt='${salt}',password_hash='${encoded}' WHERE id='${user.id}' AND salt='${plan.previousSalt}' AND password_hash='${plan.previousHash}';`;
 await sql(`${change}
 DELETE FROM sessions WHERE user_id='${user.id}' AND ${applied};
 INSERT OR IGNORE INTO admin_audit(id,actor_id,target_id,action,details,created_at) SELECT '${plan.auditId}',NULL,'${user.id}','user.password.recovery','{"method":"operator"}',unixepoch() WHERE ${applied};`);
 const result=await sql(`SELECT id,salt,password_hash,role,disabled FROM users WHERE id='${user.id}'`,true);
 const confirmed=result[0].results[0];if(!confirmed||confirmed.salt!==salt||confirmed.password_hash!==encoded)throw new RecoveryError('Credentials changed concurrently; recovery was not confirmed');
 if(confirmed.role!==user.role||confirmed.disabled!==user.disabled)throw new RecoveryError('Account state changed concurrently; inspect locally before completing recovery');
 const completed={...plan,state:'complete',completedAt:new Date().toISOString()};delete completed.previousSalt;delete completed.previousHash;
 const finalized=output+'.complete-'+randomUUID();
 await writeFile(finalized,JSON.stringify(completed,null,2)+'\n',{mode:0o600,flag:'wx'});
 await rename(finalized,output);
 console.log(`Recovery confirmed; all web sessions revoked. Credentials saved locally: ${output}`);
}
try{await main();}
catch(error){
 // Child process diagnostics may contain salts/hashes. Print only controlled
 // operator-facing errors and retain any pending private plan for resumption.
 const message=error instanceof RecoveryError?error.message:error.code==='EEXIST'?'Output already exists; choose a new file or resume its pending recovery.':'Recovery could not be confirmed. Any pending private plan is retained; inspect locally before resuming.';
 console.error(message);process.exitCode=1;
}finally{if(temporary)await unlink(temporary).catch(()=>{});}
