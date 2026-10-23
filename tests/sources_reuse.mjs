// Local-only API/R2 regression: cancellation, owner-scoped reuse and physical cleanup.
import assert from "node:assert/strict";
import {fastExecution} from './execution-fixture.mjs';
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
const origin = "http://127.0.0.1:8787",
  suffix = randomBytes(5).toString("hex");
const channels = [],
  executors = [];
async function api(
  owner,
  path,
  { data, method = data ? "POST" : "GET", token, lease, status } = {},
) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(owner ? { Cookie: owner.cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(lease ? { "X-Lease-Token": lease } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (status) assert.equal(r.status, status, `${method} ${path}`);
  else assert.ok(r.ok, `${method} ${path}: HTTP ${r.status}`);
  return { response: r, body: await r.json() };
}
async function user(label) {
  const { response } = await api(null, "/api/auth/register", {
    data: {
      username: `${label}_${suffix}`,
      password: randomBytes(32).toString("hex"),
      invite: "local-integration-invite-only",
    },
  });
  const cookie=response.headers.get("set-cookie").split(";")[0];
  await fastExecution(origin,cookie);
  return { cookie };
}
async function channel(owner, label) {
  const id = (
    await api(owner, "/api/channels", { data: { title: label + suffix } })
  ).body.id;
  channels.push([owner, id]);
  return id;
}
async function executor(owner) {
  const e = (
    await api(owner, "/api/executors", { data: { name: "reuse-test" } })
  ).body;
  executors.push([owner, e.id]);
  return e;
}
const snapshot = async (owner) => (await api(owner, "/api/dashboard")).body;
const add = async (owner, cid, urls) =>
  (await api(owner, `/api/channels/${cid}/sources`, { data: { urls } })).body;
const claim = async (e) =>
  (await api(null, "/api/executor/claim", { token: e.token, data: {} })).body
    .job;
const scan = async (e, job, entries) =>
  api(null, `/api/executor/jobs/${job.id}/scan`, {
    token: e.token,
    lease: job.leaseToken,
    data: { entries, recurring: false },
  });
const removeChannel = async (owner, cid) =>
  api(owner, `/api/channels/${cid}`, { method: "DELETE" });
const video = "abcdefghijk",
  url = `https://www.youtube.com/watch?v=${video}`;
const entry = { video_id: video, title: "Shared test audio", duration: 5 };
let alice, bob;
try {
  alice = await user("reuse_a");
  bob = await user("reuse_b");
  const a = await channel(alice, "A"),
    b = await channel(alice, "B");
  const e1 = await executor(alice),
    e2 = await executor(alice);
  const first = await add(alice, a, [
    url,
    `https://youtu.be/${video}?si=tracking`,
    `https://www.youtube.com/shorts/${video}`,
  ]);
  assert.equal(first.added, 1);
  assert.equal(first.duplicates, 2);
  assert.equal((await add(alice, a, [url + "&t=10"])).added, 0);
  let d = await snapshot(alice);
  const source = d.sources.find((s) => s.channel_id === a);
  assert.equal(d.jobs.length, 1);
  await api(bob, `/api/channels/${a}/sources/${source.id}`, {
    method: "DELETE",
    status: 404,
  });
  const cancelled = await claim(e1);
  await api(alice, `/api/channels/${a}/sources/${source.id}`, {
    method: "DELETE",
  });
  await api(null, `/api/executor/jobs/${cancelled.id}/heartbeat`, {
    token: e1.token,
    lease: cancelled.leaseToken,
    data: {},
    status: 409,
  });
  await api(null, `/api/executor/jobs/${cancelled.id}/scan`, {
    token: e1.token,
    lease: cancelled.leaseToken,
    data: { entries: [entry] },
    status: 409,
  });
  assert.equal((await snapshot(alice)).episodes.length, 0);
  await add(alice, a, [url]);
  await add(alice, b, [url]);
  const scans = await Promise.all([claim(e1), claim(e2)]);
  assert.ok(scans.every((j) => j.kind === "scan"));
  await Promise.all(scans.map((j, i) => scan(i ? e2 : e1, j, [entry, entry])));
  d = await snapshot(alice);
  assert.equal(d.episodes.length, 2);
  const claims = await Promise.all([claim(e1), claim(e2)]);
  assert.equal(
    claims.filter(Boolean).length,
    1,
    "Only one user/video transcode may run concurrently",
  );
  const index = claims.findIndex(Boolean),
    job = claims[index],
    machine = index ? e2 : e1;
  const audio = Buffer.from("ID3-local-reuse-test-audio");
  const uploaded = await fetch(origin + `/api/executor/jobs/${job.id}/audio`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machine.token}`,
      "X-Lease-Token": job.leaseToken,
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
    },
    body: audio,
  });
  assert.equal(uploaded.status, 200);
  assert.equal(await claim(e1), null);
  d = await snapshot(alice);
  assert.equal(d.episodes.filter((e) => e.object_key).length, 2);
  assert.equal(d.episodes[0].object_key, d.episodes[1].object_key);
  assert.equal(d.jobs.filter((j) => j.reused === 1).length, 1);
  assert.equal(
    d.bytes,
    audio.length,
    "Shared physical audio must count only once",
  );
  const sharedKey = d.episodes[0].object_key;
  const c = await channel(alice, "C");
  assert.equal(
    (await add(alice, c, [url])).reused,
    1,
    "Ready single videos skip scanning and conversion",
  );
  assert.equal(await claim(e1), null);
  d = await snapshot(alice);
  assert.equal(d.bytes, audio.length);
  const cChannel = d.channels.find((x) => x.id === c),
    cEpisode = d.episodes.find((x) => x.channel_id === c);
  const cMedia = `/media/${cChannel.feed_token}/${cEpisode.id}.mp3`;
  const cFeed = await fetch(origin + `/feed/${cChannel.feed_token}.xml`);
  assert.equal(cFeed.status, 200);
  assert.ok((await cFeed.text()).includes(cEpisode.id));
  const bChannel = d.channels.find((x) => x.id === b),
    bEpisode = d.episodes.find((x) => x.channel_id === b);
  assert.equal(
    (await fetch(origin + `/media/${bChannel.feed_token}/${cEpisode.id}.mp3`))
      .status,
    404,
    "Sharing storage must not bypass channel RSS credentials",
  );
  const foreign = await channel(bob, "Foreign");
  assert.equal((await add(bob, foreign, [url])).reused, 0);
  const other = await executor(bob),
    otherScan = await claim(other);
  assert.equal(otherScan.kind, "scan");
  await scan(other, otherScan, [entry]);
  assert.equal(
    (await claim(other)).kind,
    "transcode",
    "Another user must not read the owner's cache",
  );
  await api(bob, `/api/executors/${other.id}`, { method: "DELETE" });
  await removeChannel(alice, a);
  assert.deepEqual(
    Buffer.from(await (await fetch(origin + cMedia)).arrayBuffer()),
    audio,
  );
  assert.equal((await snapshot(alice)).bytes, audio.length);
  await removeChannel(alice, b);
  assert.deepEqual(
    Buffer.from(await (await fetch(origin + cMedia)).arrayBuffer()),
    audio,
  );
  // Removing a source keeps ready episodes and their RSS available.
  d = await snapshot(alice);
  await api(
    alice,
    `/api/channels/${c}/sources/${d.sources.find((s) => s.channel_id === c).id}`,
    { method: "DELETE" },
  );
  assert.equal((await fetch(origin + cMedia)).status, 200);
  await removeChannel(alice, c);
  assert.equal((await snapshot(alice)).bytes, 0);
  const result = await promisify(execFile)(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "r2",
      "object",
      "get",
      `youtast-audio/${sharedKey}`,
      "--local",
      "--file",
      resolve("test-results/reuse-deleted-audio.mp3"),
    ],
    { windowsHide: true },
  ).then(
    () => null,
    (error) => error,
  );
  assert.ok(
    result,
    "Last-reference deletion must physically remove the R2 object",
  );
  assert.match(result.stdout + result.stderr, /not exist|not found|NoSuchKey/i);
  const cap = await channel(alice, "Cap");
  const urls = Array.from(
    { length: 29 },
    (_, i) =>
      `https://www.youtube.com/watch?v=cap${String(i).padStart(8, "0")}`,
  );
  for (let offset = 0; offset < urls.length; offset += 10)
    await add(alice, cap, urls.slice(offset, offset + 10));
  const raced = await Promise.all(
    ["cap99999998", "cap99999999"].map((id) =>
      fetch(origin + `/api/channels/${cap}/sources`, {
        method: "POST",
        headers: {
          Origin: origin,
          Cookie: alice.cookie,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ urls: [`https://youtu.be/${id}`] }),
      }),
    ),
  );
  assert.deepEqual(raced.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    (await add(alice, cap, [urls[0], urls[0] + "&t=1"])).added,
    0,
    "Duplicates must not exhaust source slots",
  );
  assert.equal(
    (await snapshot(alice)).sources.filter((s) => s.channel_id === cap).length,
    30,
  );
  console.log(
    "PASS: source deletion/lease fencing, URL dedup, concurrent video exclusion, owner-only audio reuse, physical quota and last-reference R2 cleanup",
  );
} finally {
  for (const [owner, id] of executors.reverse())
    await api(owner, `/api/executors/${id}`, { method: "DELETE" }).catch(
      () => {},
    );
  for (const [owner, id] of channels.reverse())
    await api(owner, `/api/channels/${id}`, {
      method: "DELETE",
      status: undefined,
    }).catch(() => {});
  for (const owner of [alice, bob].filter(Boolean))
    await api(owner, "/api/auth/logout", { data: {} }).catch(() => {});
}
