import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';

export function localDatabase(origin,persistTo=process.env.TEST_PERSIST_TO) {
 assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/,'SQL fixtures require a local test server');
 return async command=>{
  await mkdir('test-results',{recursive:true});
  const file=resolve(`test-results/fixture-${randomUUID()}.sql`);
  await writeFile(file,command);
  try{
   const {stdout}=await promisify(execFile)(process.execPath,[resolve('node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--local',...(persistTo?['--persist-to',persistTo]:[]),'--file',file,'--json'],{windowsHide:true,env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
   return JSON.parse(stdout);
  }finally{await unlink(file);}
 };
}

export async function cleanupLocalUsers({origin,sql,accounts}) {
 assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/,'User cleanup is local-only');
 if(!accounts.length)return;
 for(const {id,username} of accounts){
  assert.match(id,/^[a-f0-9-]{36}$/i);
  assert.match(username,/^[a-zA-Z0-9_]{3,40}$/);
 }
 // Both identifiers came from successful registrations in this test run.
 // Never remove by prefix, clear login_limits, or remove retained admins.
 const match=accounts.map(({id,username})=>`(id='${id}' AND username='${username}')`).join(' OR ');
 await sql(`DELETE FROM users WHERE role='user' AND (${match})`);
 const result=await sql(`SELECT COUNT(*) remaining FROM users WHERE ${match}`);
 assert.equal(result[0].results[0].remaining,0,'Fixture accounts must not remain after cleanup');
}
