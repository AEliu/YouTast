import test from "node:test";
import {fastExecution} from './execution-fixture.mjs';
import {localDatabase,cleanupLocalUsers} from './local-fixture.mjs';
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

const origin = process.env.TEST_ORIGIN || "http://127.0.0.1:8787";
const invite = process.env.TEST_INVITE || "local-integration-invite-only";
const suffix = process.env.TEST_RUN_SUFFIX || Date.now().toString(36),
  password = randomBytes(32).toString("hex");
async function request(
  path,
  { cookie, token, lease, method = "GET", data, raw, headers = {} } = {},
) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (token) h.Authorization = `Bearer ${token}`;
  if (lease) h["X-Lease-Token"] = lease;
  if (method !== "GET" && !token && !h.Origin) h.Origin = origin;
  if (data) {
    h["Content-Type"] = "application/json";
    raw = JSON.stringify(data);
  }
  const response = await fetch(origin + path, {
    method,
    headers: h,
    body: raw,
  });
  return response;
}
test("Full local flow: privacy, competing executors, leases, audio ranges, rotation and revocation", async context => {
  const accounts=[];
  if(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)){
    const sql=localDatabase(origin);
    context.after(()=>cleanupLocalUsers({origin,sql,accounts}));
  }
  let r = await request("/api/auth/register", {
    method: "POST",
    data: { username: `alice_${suffix}`, password, invite },
  });
  assert.equal(r.status, 200, await r.clone().text());
  accounts.push({id:(await r.clone().json()).user.id,username:`alice_${suffix}`});
  const alice = r.headers.get("set-cookie").split(";")[0];
  await fastExecution(origin,alice);
  r = await request("/api/auth/register", {
    method: "POST",
    data: { username: `bob_${suffix}`, password, invite },
  });
  assert.equal(r.status, 200);
  accounts.push({id:(await r.clone().json()).user.id,username:`bob_${suffix}`});
  const bob = r.headers.get("set-cookie").split(";")[0];
  r = await request("/api/channels", {
    cookie: alice,
    method: "POST",
    data: { title: "Integration & <private>", description: "Test podcast" },
  });
  assert.equal(r.status, 201);
  const cid = (await r.json()).id;
  r = await request(`/api/channels/${cid}/sources`, {
    cookie: bob,
    method: "POST",
    data: { urls: ["https://youtu.be/dQw4w9WgXcQ"] },
  });
  assert.equal(r.status, 404);
  r = await request("/api/channels", {
    cookie: alice,
    method: "POST",
    headers: { Origin: "https://attacker.invalid" },
    data: { title: "forged" },
  });
  assert.equal(r.status, 403);
  r = await request("/api/executors", {
    cookie: alice,
    method: "POST",
    data: { name: "test-machine" },
  });
  const executor = await r.json();
  assert.match(executor.token, /^[a-f0-9]{64}$/);
  r = await request("/api/executors", {
    cookie: bob,
    method: "POST",
    data: { name: "other-user" },
  });
  const other = await r.json();
  r = await request(`/api/channels/${cid}/sources`, {
    cookie: alice,
    method: "POST",
    data: { urls: ["https://www.youtube.com/@test_creator"] },
  });
  assert.equal(r.status, 201, await r.clone().text());
  r = await request("/api/executor/claim", {
    token: other.token,
    method: "POST",
    data: {},
  });
  assert.equal((await r.json()).job, null);
  const claims = await Promise.all(
    Array.from({ length: 6 }, () =>
      request("/api/executor/claim", {
        token: executor.token,
        method: "POST",
        data: {},
      }).then((r) => r.json()),
    ),
  );
  const claimed = claims.map((x) => x.job).filter(Boolean);
  assert.equal(claimed.length, 1);
  const scan = claimed[0];
  assert.equal(scan.kind, "scan");
  r = await request(`/api/executor/jobs/${scan.id}/heartbeat`, {
    token: executor.token,
    lease: "wrong",
    method: "POST",
    data: {},
  });
  assert.equal(r.status, 409);
  r = await request(`/api/executor/jobs/${scan.id}/heartbeat`, {
    token: executor.token,
    lease: scan.leaseToken,
    method: "POST",
    data: {},
  });
  assert.equal(r.status, 200);
  const entries = [
    { video_id: "dQw4w9WgXcQ", title: "Test & <episode>", duration: 60 },
    { video_id: "abcdefghijk", title: "Second", duration: 80 },
  ];
  r = await request(`/api/executor/jobs/${scan.id}/scan`, {
    token: executor.token,
    lease: scan.leaseToken,
    method: "POST",
    data: { entries, recurring: true },
  });
  assert.equal(r.status, 200, await r.clone().text());
  r = await request(`/api/executor/jobs/${scan.id}/scan`, {
    token: executor.token,
    lease: scan.leaseToken,
    method: "POST",
    data: { entries, recurring: true },
  });
  assert.equal(r.status, 409);
  const transcodes = (
    await Promise.all(
      Array.from({ length: 6 }, () =>
        request("/api/executor/claim", {
          token: executor.token,
          method: "POST",
          data: {},
        }).then((r) => r.json()),
      ),
    )
  )
    .map((x) => x.job)
    .filter(Boolean);
  assert.equal(transcodes.length, 2);
  assert.notEqual(transcodes[0].id, transcodes[1].id);
  const audio = Buffer.from("ID3fake-audio-for-integration-only");
  for (const job of transcodes) {
    r = await request(`/api/executor/jobs/${job.id}/audio`, {
      token: executor.token,
      lease: job.leaseToken,
      method: "POST",
      raw: audio,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.length),
        "X-Audio-Duration": "42",
      },
    });
    assert.equal(r.status, 200, await r.clone().text());
  }
  r = await request("/api/dashboard", { cookie: alice });
  let dashboard = await r.json();
  assert.equal(dashboard.channels[0].episode_count, 2);
  assert.equal(dashboard.bytes, audio.length * 2);
  assert.equal(dashboard.executors[0].token_hash, undefined);
  r = await request("/api/dashboard", { cookie: bob });
  assert.equal((await r.json()).channels.length, 0);
  const feedToken = dashboard.channels[0].feed_token,
    episode = dashboard.episodes[0];
  r = await request(`/subscribe/${feedToken}?client=overcast`);
  assert.equal(r.status,200);
  assert.equal(r.headers.get('referrer-policy'),'no-referrer');
  assert.match(r.headers.get('cache-control'),/no-store/);
  assert.match(r.headers.get('x-robots-tag'),/noindex/);
  const subscribe=await r.text();
  assert.ok(subscribe.includes('Integration &amp; &lt;private&gt;'));
  assert.ok(subscribe.includes('value="overcast" selected'));
  assert.ok(subscribe.includes('overcast://x-callback-url/add?url='));
  assert.equal((await request(`/subscribe/${feedToken}`,{method:'HEAD'})).status,200);
  assert.equal((await request('/subscribe/not-a-token')).status,404);
  assert.equal((await request(`/subscribe/${'0'.repeat(64)}`)).status,404);
  assert.equal((await request(`/subscribe/${feedToken}`,{method:'POST'})).status,405);
  r = await request(`/feed/${feedToken}.xml`);
  assert.equal(r.status, 200);
  const rss = await r.text();
  assert.match(rss, /Integration &amp; &lt;private&gt;/);
  assert.equal((rss.match(/<enclosure /g) || []).length, 2);
  const media = `/media/${feedToken}/${episode.id}.mp3`;
  r = await request(media, { headers: { Range: "bytes=3-7" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), `bytes 3-7/${audio.length}`);
  assert.equal(await r.text(), audio.subarray(3, 8).toString());
  r = await request(media, { headers: { Range: "bytes=-4" } });
  assert.equal(r.status, 206);
  assert.equal(await r.text(), audio.subarray(-4).toString());
  r = await request(media, { headers: { Range: "bytes=999999-" } });
  assert.equal(r.status, 416);
  r = await request(`/api/channels/${cid}/rotate`, {
    cookie: alice,
    method: "POST",
    data: {},
  });
  assert.equal(r.status, 200);
  r = await request(`/feed/${feedToken}.xml`);
  assert.equal(r.status, 404);
  assert.equal((await request(`/subscribe/${feedToken}`)).status,404);
  r = await request(media);
  assert.equal(r.status, 404);
  r = await request(`/api/executors/${executor.id}`, {
    cookie: alice,
    method: "DELETE",
  });
  assert.equal(r.status, 200);
  r = await request("/api/executor/claim", {
    token: executor.token,
    method: "POST",
    data: {},
  });
  assert.equal(r.status, 401);
  r = await request(`/api/channels/${cid}`, {
    cookie: alice,
    method: "DELETE",
  });
  assert.equal(r.status, 200);
  r = await request("/api/auth/logout", {
    cookie: alice,
    method: "POST",
    data: {},
  });
  assert.equal(r.status, 200);
  r = await request("/api/me", { cookie: alice });
  assert.equal(r.status, 401);
});
