// Operator CLI only. Writes a new admin's password to an ignored local file, never stdout or SQL.
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve} from 'node:path';
import {id,secret,passwordHash,now} from '../src/lib.js';
const root=resolve('.'), destination=resolve('.secrets/admin-account.env');
const origin=new URL(process.env.YOUTAST_URL || '');
if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Set YOUTAST_URL to your HTTPS application origin');
async function sql(command){
 const file=resolve('.secrets/admin-bootstrap.sql');
 await writeFile(file,command,{encoding:'utf8',mode:0o600});
 try {
  const operation=/^\s*SELECT\b/i.test(command)?['--command',command]:['--file',file];
  const {stdout}=await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--remote','--json',...operation],{cwd:root,windowsHide:true,maxBuffer:1_000_000});
  return JSON.parse(stdout.slice(stdout.indexOf('[')));
 }finally{await unlink(file);}
}
await mkdir(resolve('.secrets'),{recursive:true});
let existing;
try{existing=await readFile(destination,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(existing){
 const username=existing.match(/^YOUTAST_USERNAME=([a-z0-9_-]+)$/m)?.[1];
 if(!username)throw new Error('Existing admin credential file is not valid; left untouched');
 const result=await sql(`SELECT id FROM users WHERE username='${username}' AND role='admin' AND disabled=0;`);
 if(!result[0].results.length)throw new Error('Saved admin is not enabled; credentials left untouched');
 console.log('Existing admin retained: '+username+'; credential file: '+destination);
}else{
 const pendingPath=resolve('.secrets/admin-bootstrap.pending.json');
 let pending;
 try{pending=JSON.parse(await readFile(pendingPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 if(pending){
  if(!/^[a-z0-9_-]{3,40}$/.test(pending.username)||!/^[-a-f0-9]{36}$/.test(pending.uid)||!/^[a-f0-9]{64}$/.test(pending.password))throw new Error('Invalid pending admin data; left untouched');
  const recovered=await sql(`SELECT id,role,disabled FROM users WHERE username='${pending.username}';`);
  if(recovered[0].results.length){
   const row=recovered[0].results[0];
   if(row.id!==pending.uid||row.role!=='admin'||row.disabled)throw new Error('Pending admin does not match database; left untouched');
   await writeFile(destination,`YOUTAST_URL=${origin.origin}\nYOUTAST_USERNAME=${pending.username}\nYOUTAST_PASSWORD=${pending.password}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
   await unlink(pendingPath);console.log('Admin creation recovered: '+pending.username+'; credential file: '+destination);process.exit(0);
  }
 }
 const names=await sql("SELECT username FROM users WHERE username IN ('admin','youtast_admin');");
 const taken=new Set(names[0].results.map(r=>r.username));
 const username=pending?.username||(!taken.has('admin')?'admin':!taken.has('youtast_admin')?'youtast_admin':'admin_'+secret().slice(0,8));
 const password=pending?.password||secret(),salt=secret(),uid=pending?.uid||id(),digest=await passwordHash(password,salt);
 if(!pending)await writeFile(pendingPath,JSON.stringify({uid,username,password}),{encoding:'utf8',mode:0o600,flag:'wx'});
 await sql(`INSERT INTO users(id,username,salt,password_hash,created_at,role) VALUES('${uid}','${username}','${salt}','${digest}',${now()},'admin'); INSERT INTO admin_audit(id,actor_id,target_id,action,created_at) VALUES('${id()}','${uid}','${uid}','admin.bootstrap',${now()});`);
 const result=await sql(`SELECT id FROM users WHERE id='${uid}' AND role='admin' AND disabled=0;`);
 if(result[0].results[0]?.id!==uid)throw new Error('Admin creation was not confirmed');
 await writeFile(destination,`YOUTAST_URL=${origin.origin}\nYOUTAST_USERNAME=${username}\nYOUTAST_PASSWORD=${password}\n`,{encoding:'utf8',mode:0o600,flag:'wx'});
 await unlink(pendingPath);
 console.log('Admin created: '+username+'; password stored only in: '+destination);
}
