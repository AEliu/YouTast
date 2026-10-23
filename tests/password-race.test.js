import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import worker from '../src/worker.js';
import {changePassword} from '../src/passwords.js';
import {secret,passwordHash} from '../src/lib.js';

test('a login paused after checking the old password cannot mint a session after password change',async()=>{
 const db=new DatabaseSync(':memory:');
 const statement=(sql,values=[])=>({
  bind(...bound){return statement(sql,bound);},
  async first(){return db.prepare(sql).get(...values)||null;},
  async all(){return {results:db.prepare(sql).all(...values)};},
  async run(){return {meta:{changes:db.prepare(sql).run(...values).changes}};},
  execute(){return {results:db.prepare(sql).all(...values)};},
 });
 const env={DB:{prepare:statement,async batch(statements){db.exec('BEGIN');try{const results=statements.map(s=>s.execute());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 let release,reached,timer;
 const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{reached=resolve;});
 const original=crypto.subtle.deriveBits,descriptor=Object.getOwnPropertyDescriptor(crypto.subtle,'deriveBits');
 try{
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())db.exec(await readFile(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const user={id:crypto.randomUUID(),username:'race_fixture'},old='old-login-password-fixture',next='new-login-password-fixture',salt=secret();
  db.prepare('INSERT INTO users(id,username,salt,password_hash,created_at) VALUES(?,?,?,?,?)').run(user.id,user.username,salt,await passwordHash(old,salt),1000);
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(secret(),user.id,9999999999);
  let paused=false;
  Object.defineProperty(crypto.subtle,'deriveBits',{configurable:true,value:async function(...args){
   const derived=await original.apply(this,args);
   if(!paused){paused=true;reached();await held;}
   return derived;
  }});
  const login=worker.fetch(new Request('http://127.0.0.1:8794/api/auth/login',{method:'POST',headers:{Origin:'http://127.0.0.1:8794','Content-Type':'application/json'},body:JSON.stringify({username:user.username,password:old})}),env);
  await Promise.race([ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Old login did not reach the credential-check barrier')),5000);})]);
  clearTimeout(timer);
  await changePassword(env,user,{current_password:old,new_password:next});
  release();
  assert.equal((await login).status,401,'An in-flight old login must be rejected at session insertion');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE user_id=?').get(user.id).n,0);
 }finally{
  clearTimeout(timer);release();
  if(descriptor)Object.defineProperty(crypto.subtle,'deriveBits',descriptor);else delete crypto.subtle.deriveBits;
  db.close();
 }
});
