import {fetchWithDiscovery as fetch} from './discovery-fixture.mjs';
// Local API regression: a recovered scan must not retain a stale failure reason.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8791";
const database=localDatabase(origin,process.env.TEST_PERSIST_TO||'.wrangler/job-recovery-state'),accounts=[];
const testIp=`2001:db8:${randomBytes(2).toString('hex')}:${randomBytes(2).toString('hex')}::1`;
const cli = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
let cookie = "",
  token,
  executorId,
  channel;
const sql = database;
async function api(
  path,
  data,
  auth = "user",
  method = data ? "POST" : "GET",
  lease,
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      'CF-Connecting-IP':testIp,
      "Content-Type": "application/json",
      ...(auth === "executor"
        ? { Authorization: `Bearer ${token}` }
        : { Cookie: cookie }),
      ...(lease ? { "X-Lease-Token": lease } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert.ok(response.ok, `Unexpected API status ${response.status}`);
  if (path === "/api/auth/register")
    cookie = response.headers.get("set-cookie").split(";")[0];
  const body=await response.json();
  if(path==='/api/auth/register')accounts.push(body.user);
  return body;
}
try {
  await api("/api/auth/register", {
    username: "recovery_" + randomBytes(6).toString("hex"),
    password: randomBytes(32).toString("hex"),
    invite: process.env.TEST_INVITE || "local-job-recovery",
  });
  await api('/api/execution-policy',{concurrency:3,start_interval:0,request_interval:0,download_wait:0,cooldown_seconds:60,paused:false});
  channel = (await api("/api/channels", { title: "Recovery regression" })).id;
  const executor = await api("/api/executors", { name: "Recovery regression" });
  token = executor.token;
  executorId = executor.id;
  await api(`/api/channels/${channel}/sources`, {
    urls: ["https://www.youtube.com/watch?v=jNQXAC9IVRw"],
  });
  let job = (await api("/api/executor/claim", {}, "executor")).job;
  assert.ok(job && /^[a-f0-9]{32}$/.test(job.id));
  await api(
    `/api/executor/jobs/${job.id}/fail`,
    { error: "Temporary verification failure" },
    "executor",
    "POST",
    job.leaseToken,
  );
  assert.equal(
    (await api("/api/dashboard")).jobs.find((j) => j.id === job.id).error,
    "Temporary verification failure",
  );
  // Advance only this disposable local task's backoff, without delaying the suite.
  await sql(`UPDATE jobs SET available_at=0 WHERE id='${job.id}'`);
  job = (await api("/api/executor/claim", {}, "executor")).job;
  assert.equal(
    (await api("/api/dashboard")).jobs.find((j) => j.id === job.id).attempts,
    2,
  );
  assert.equal(
    (await api("/api/dashboard")).jobs.find((j) => j.id === job.id).error,
    null,
  );
  await api(
    `/api/executor/jobs/${job.id}/scan`,
    { entries: [], recurring: false },
    "executor",
    "POST",
    job.leaseToken,
  );
  let finished = (await api("/api/dashboard")).jobs.find(
    (j) => j.id === job.id,
  );
  assert.equal(finished.status, "done");
  assert.equal(finished.error, null);
  // Already-completed rows from older deployments must also display correctly.
  await sql(`UPDATE jobs SET error='Legacy stale error' WHERE id='${job.id}'`);
  finished = (await api("/api/dashboard")).jobs.find((j) => j.id === job.id);
  assert.equal(finished.status, "done");
  assert.equal(finished.error, null);
  console.log(
    "PASS: failed -> retry -> success clears errors; legacy completed errors stay hidden",
  );
} finally {
  try {
  if (executorId)
    await api(`/api/executors/${executorId}`, undefined, "user", "DELETE");
  if (channel)
    await api(`/api/channels/${channel}`, undefined, "user", "DELETE");
  if (cookie) await api("/api/auth/logout", {});
  } finally {await cleanupLocalUsers({origin,sql:database,accounts});}
}
