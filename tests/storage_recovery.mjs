import {fetchWithDiscovery as fetch} from './discovery-fixture.mjs';
// Local D1/R2 integration: orphan quota, scheduled cleanup and active lease fencing.
// Every Wrangler storage command explicitly uses --local.
import assert from "node:assert/strict";
import {fastExecution} from './execution-fixture.mjs';
import { randomUUID, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = resolve(root, "node_modules/wrangler/bin/wrangler.js");
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8787";
const database=localDatabase(origin),accounts=[];
const testIp=`2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`;
const exec = promisify(execFile);
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
let cookie = "";
async function command(args) {
  return exec(process.execPath, [cli, ...args,...(process.env.TEST_PERSIST_TO?['--persist-to',process.env.TEST_PERSIST_TO]:[])], {
    cwd: root,
    timeout: 30000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
}
async function sql(query) {
  return command(["d1", "execute", "DB", "--local", "--command", query]);
}
async function request(path, data, method) {
  const response = await fetch(origin + path, {
    method: method || (data ? "POST" : "GET"),
    headers: {
      Origin: origin,
      'CF-Connecting-IP':testIp,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert.ok(response.ok, await response.clone().text());
  return response;
}
async function dashboard() {
  return (await request("/api/dashboard")).json();
}
async function scheduled() {
  const r = await fetch(origin + "/cdn-cgi/local/scheduled");
  assert.equal(r.status, 200, await r.text());
}
async function missing(key, file) {
  let rejected = false;
  try {
    await command([
      "r2",
      "object",
      "get",
      `youtast-audio/${key}`,
      "--local",
      "--file",
      file,
    ]);
  } catch (error) {
    rejected = true;
    assert.match(error.stderr + error.stdout, /not exist|not found|NoSuchKey/i);
  }
  assert.ok(rejected, "Garbage object still exists in local R2");
}

const results = resolve(root, "test-results");
await mkdir(results, { recursive: true });
const temp = await mkdtemp(join(results, "storage-recovery-"));
let channelId, executor;
try {
  const response = await request("/api/auth/register", {
    username: "gc_" + randomBytes(5).toString("hex"),
    password: randomBytes(32).toString("hex"),
    invite: process.env.TEST_INVITE || "local-integration-invite-only",
  });
  cookie = response.headers.get("set-cookie").split(";")[0];
  await fastExecution(origin,cookie);
  const user = (await response.json()).user;
  accounts.push(user);
  const payload = Buffer.from("ID3 durable cleanup test");
  const source = join(temp, "source.mp3"),
    output = join(temp, "download.mp3");
  await writeFile(source, payload);
  const key = `${user.id}/${randomUUID()}/${randomUUID()}/orphan.mp3`;
  await command([
    "r2",
    "object",
    "put",
    `youtast-audio/${key}`,
    "--local",
    "--file",
    source,
  ]);
  await sql(
    `INSERT INTO object_gc(object_key,user_id,size,not_before,created_at) VALUES(${quote(key)},${quote(user.id)},${payload.length},0,unixepoch())`,
  );
  assert.equal(
    (await dashboard()).bytes,
    payload.length,
    "An orphan must remain charged against its owner",
  );
  await scheduled();
  assert.equal(
    (await dashboard()).bytes,
    0,
    "Confirmed R2 cleanup should release quota",
  );
  await missing(key, output);

  channelId = (
    await (await request("/api/channels", { title: "GC lease test" })).json()
  ).id;
  executor = await (
    await request("/api/executors", { name: "gc-lease-test" })
  ).json();
  await request(`/api/channels/${channelId}/sources`, {
    urls: ["https://youtu.be/jNQXAC9IVRw"],
  });
  const claim = await fetch(origin + "/api/executor/claim", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${executor.token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(claim.status, 200);
  const { job } = await claim.json();
  const liveKey = `${user.id}/${channelId}/${randomUUID()}/active.mp3`;
  await command([
    "r2",
    "object",
    "put",
    `youtast-audio/${liveKey}`,
    "--local",
    "--file",
    source,
  ]);
  // Copy the lease inside SQLite; no bearer or lease secret enters process arguments.
  await sql(
    `INSERT INTO object_gc(object_key,user_id,size,not_before,job_id,lease_token,created_at) SELECT ${quote(liveKey)},user_id,${payload.length},0,id,lease_token,unixepoch() FROM jobs WHERE id=${quote(job.id)}`,
  );
  await scheduled();
  assert.equal(
    (await dashboard()).bytes,
    payload.length,
    "Cleanup must preserve an active upload lease",
  );
  await command([
    "r2",
    "object",
    "get",
    `youtast-audio/${liveKey}`,
    "--local",
    "--file",
    output,
  ]);
  assert.deepEqual(await readFile(output), payload);
  await request(`/api/executors/${executor.id}`, undefined, "DELETE");
  executor = null;
  await scheduled();
  assert.equal(
    (await dashboard()).bytes,
    0,
    "Revoked upload intent must be reclaimed",
  );
  await missing(liveKey, join(temp, "deleted.mp3"));
  console.log(
    "PASS: orphan objects count toward quota, scheduled cleanup deletes them, and active leases protect uploads",
  );
} finally {
  try {
  if (executor)
    await request(`/api/executors/${executor.id}`, undefined, "DELETE");
  if (channelId)
    await request(`/api/channels/${channelId}`, undefined, "DELETE");
  } finally {await cleanupLocalUsers({origin,sql:database,accounts});}
  if (!temp.startsWith(results + sep))
    throw new Error("Unexpected test cleanup target");
  await rm(temp, { recursive: true, force: true });
}
