import test from "node:test";
import {fastExecution} from './execution-fixture.mjs';
import assert from "node:assert/strict";
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8788";
test("Concurrent uploads cannot overbook the 50-byte isolated test quota", async (t) => {
  const sql=localDatabase(origin,process.env.TEST_PERSIST_TO||'.wrangler/quota-state'),accounts=[];
  t.after(()=>cleanupLocalUsers({origin,sql,accounts}));
  let cookie = "";
  async function req(path, data, extra = {}) {
    const response = await fetch(origin + path, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        ...extra.headers,
      },
      body: JSON.stringify(data),
      ...extra,
    });
    return response;
  }
  let r = await req("/api/auth/register", {
    username: "quota_" + Date.now().toString(36),
    password: "Long-quota-test-password",
    invite: "local-integration-invite-only",
  });
  assert.equal(r.status, 200);
  accounts.push((await r.clone().json()).user);
  cookie = r.headers.get("set-cookie").split(";")[0];
  await fastExecution(origin,cookie);
  r = await req("/api/channels", { title: "Quota test" });
  const cid = (await r.json()).id;
  r = await req("/api/executors", { name: "quota-test" });
  const executor = await r.json();
  const workerHeaders = {
    Authorization: `Bearer ${executor.token}`,
    "Content-Type": "application/json",
  };
  async function worker(path, data, lease) {
    return fetch(origin + "/api/executor" + path, {
      method: "POST",
      headers: {
        ...workerHeaders,
        ...(lease ? { "X-Lease-Token": lease } : {}),
      },
      body: JSON.stringify(data),
    });
  }
  try {
    r = await req(`/api/channels/${cid}/sources`, {
      urls: ["https://www.youtube.com/@quota_test"],
    });
    assert.equal(r.status, 201);
    r = await worker("/claim", {});
    const scan = (await r.json()).job;
    r = await worker(
      `/jobs/${scan.id}/scan`,
      {
        entries: [
          { video_id: "abcdefghijk", title: "One", duration: 1 },
          { video_id: "dQw4w9WgXcQ", title: "Two", duration: 1 },
        ],
      },
      scan.leaseToken,
    );
    assert.equal(r.status, 200);
    const jobs = await Promise.all(
      [worker("/claim", {}), worker("/claim", {})].map(
        async (r) => (await (await r).json()).job,
      ),
    );
    const statuses = await Promise.all(
      jobs.map(
        async (j) =>
          (
            await fetch(origin + `/api/executor/jobs/${j.id}/audio`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${executor.token}`,
                "X-Lease-Token": j.leaseToken,
                "Content-Type": "audio/mpeg",
                "Content-Length": "32",
              },
              body: Buffer.alloc(32, 65),
            })
          ).status,
      ),
    );
    assert.deepEqual(statuses.sort(), [200, 409]);
    r = await fetch(origin + "/api/dashboard", { headers: { Cookie: cookie } });
    assert.equal((await r.json()).bytes, 32);
  } finally {
    await fetch(origin + `/api/executors/${executor.id}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: origin },
    });
    await fetch(origin + `/api/channels/${cid}`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: origin },
    });
  }
});
