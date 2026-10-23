// Check this machine's real cloud registration; optionally submit a disposable YouTube smoke job.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setDefaultResultOrder } from "node:dns";
setDefaultResultOrder("ipv4first");
const root = fileURLToPath(new URL("../", import.meta.url));
const parse = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
const testVideo = process.argv.includes("--test-video");
const executor = parse(
  await readFile(resolve(root, ".secrets/windows-executor.env"), "utf8"),
);
const origin = executor.YOUTAST_URL;
const originUrl = new URL(origin);
if (originUrl.protocol !== "https:" || originUrl.username || originUrl.password || originUrl.pathname !== "/" || originUrl.search || originUrl.hash)
  throw new Error("Unexpected deployment origin");
let cookie = "",
  channelId,
  serverDate;
const result = { status: "not-run", checked_at: new Date().toISOString() };
const keepChannel = process.argv.includes("--keep-channel");
const channelTitle = keepChannel
  ? "Executor audio validation"
  : "Temporary Windows connectivity check";
const stateDir = resolve(root, ".wrangler/windows-executor");
await mkdir(stateDir, { recursive: true });
async function api(path, data, method = data ? "POST" : "GET", machineAuth = false) {
  let response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(origin + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          "User-Agent": "YouTast-Setup/0.1",
          Connection: "close",
          ...(machineAuth ? { Authorization: `Bearer ${executor.YOUTAST_TOKEN}` } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: method === "GET" ? undefined : JSON.stringify(data || {}),
      });
      break;
    } catch (error) {
      if (method !== "GET" || attempt >= 3) throw error;
      await new Promise((done) => setTimeout(done, 1000 * (attempt + 1)));
    }
  }
  const body = await response.json();
  serverDate = response.headers.get("date");
  if (!response.ok)
    throw new Error(
      `API request failed (HTTP ${response.status}): ${body.error || "unknown error"}`,
    );
  if (path === "/api/auth/login")
    cookie = response.headers.get("set-cookie")?.split(";")[0];
  return body;
}
async function readArtifact(url, text = false) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30000),
        redirect: "error",
        headers: { "User-Agent": "YouTast-Setup/0.1", Connection: "close" },
      });
      if (!response.ok)
        throw new Error(`Artifact request failed (HTTP ${response.status})`);
      if (Number(response.headers.get("content-length")) > 5_000_000)
        throw new Error("Unexpected smoke-test artifact size");
      return text
        ? await response.text()
        : Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (attempt >= 3) throw error;
      await new Promise((done) => setTimeout(done, 2000));
    }
  }
}
try {
  let processState;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      processState = JSON.parse(
        await readFile(resolve(stateDir, "process.json"), "utf8"),
      );
      if (
        processState.status === "running" &&
        Number.isInteger(processState.pid) &&
        processState.pid > 0
      ) {
        process.kill(processState.pid, 0);
        break;
      }
    } catch {}
    processState = null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  if (!processState)
    throw new Error("The Windows runner is not currently running");
  let machine, lastSeen;
  const connectionDeadline = Date.now() + 400_000;
  while (Date.now() < connectionDeadline) {
    const snapshot = await api("/api/executor/status", {}, "POST", true);
    if (snapshot.id !== executor.YOUTAST_EXECUTOR_ID)
      throw new Error("The configured executor ID does not match its token");
    machine = snapshot;
    lastSeen = machine.lastSeen;
    if (
      lastSeen >= processState.started_at &&
      Date.now() / 1000 - lastSeen <= 400
    )
      break;
    machine = null;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
  }
  if (!machine) {
    console.error(
      JSON.stringify({
        runner_started_at: processState.started_at,
        cloud_last_seen: lastSeen,
        local_now: Math.floor(Date.now() / 1000),
        server_date: serverDate,
      }),
    );
    throw new Error(
      "This runner has not checked in within its expected polling interval",
    );
  }
  console.log(`Connected executor: ${machine.name}`);
  console.log(
    `Last cloud check-in (Asia/Shanghai): ${new Date(lastSeen * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}`,
  );
  result.active_jobs = machine.activeJobs;
  result.capabilities = { rate_control: machine.rateControlVersion, content_window: machine.windowControlVersion, audio_control:machine.audioControlVersion, replay_control:machine.replayControlVersion };
  if (testVideo) {
    const owner = parse(await readFile(resolve(root, ".secrets/windows-owner.env"), "utf8"));
    if (owner.YOUTAST_URL !== origin || (executor.YOUTAST_USERNAME && owner.YOUTAST_USERNAME !== executor.YOUTAST_USERNAME))
      throw new Error("Smoke-test account does not match the configured executor owner; use the app to submit a video for this account");
    await api("/api/auth/login", { username: owner.YOUTAST_USERNAME, password: owner.YOUTAST_PASSWORD });
    const dashboard = await api("/api/dashboard");
    if (!dashboard.executors.some(item => item.id === executor.YOUTAST_EXECUTOR_ID))
      throw new Error("Smoke-test account does not own this executor; no test task was created");
    channelId = (
      await api("/api/channels", {
        title: channelTitle,
      })
    ).id;
    await api(`/api/channels/${channelId}/sources`, {
      urls: ["https://www.youtube.com/watch?v=jNQXAC9IVRw"],
    });
    console.log(
      "Queued a short public YouTube video for the running Windows executor; idle pickup can take five minutes.",
    );
    const deadline = Date.now() + 8 * 60000;
    let previous = "";
    while (Date.now() < deadline) {
      let dashboard;
      try {
        dashboard = await api("/api/dashboard");
      } catch (error) {
        if (error.message.startsWith("API request failed")) throw error;
        console.log(
          "Temporary monitoring connection failure; continuing to wait.",
        );
        await new Promise((done) => setTimeout(done, 5000));
        continue;
      }
      const jobs = dashboard.jobs.filter(
        (job) => job.channel_title === channelTitle,
      );
      const stage = jobs
        .map((job) => `${job.kind}:${job.status}:${job.attempts}`)
        .sort()
        .join(",");
      if (stage !== previous) {
        console.log("Task state: " + stage);
        previous = stage;
      }
      const error = jobs.find((job) => job.error)?.error;
      if (error) {
        result.status = "blocked";
        result.error = error;
        console.log("Real YouTube conversion blocked: " + error);
        process.exitCode = 2;
        break;
      }
      const episode = dashboard.episodes.find(
        (item) => item.channel_id === channelId && item.object_key,
      );
      if (episode) {
        const channel = dashboard.channels.find(
          (item) => item.id === channelId,
        );
        const extension=episode.object_key.endsWith('.m4a')?'m4a':'mp3';
        const url = `${origin}/media/${channel.feed_token}/${episode.id}.${extension}`;
        const rss = await readArtifact(
          `${origin}/feed/${channel.feed_token}.xml`,
          true,
        );
        if (!rss.includes(url))
          throw new Error("Completed episode is missing from RSS");
        const audio = await readArtifact(url);
        const file = resolve(stateDir, `smoke.${extension}`);
        await writeFile(file, audio);
        const { stdout } = await promisify(execFile)(
          "ffprobe",
          [
            "-v",
            "error",
            "-show_entries",
            "stream=codec_name:format=duration",
            "-of",
            "json",
            file,
          ],
          { windowsHide: true },
        );
        const probe = JSON.parse(stdout);
        if (
          !["mp3","aac"].includes(probe.streams?.[0]?.codec_name) ||
          Number(probe.format?.duration) < 1
        )
          throw new Error("Downloaded audio failed AAC/MP3 inspection");
        result.status = "passed";
        result.duration = Number(probe.format.duration);
        if (keepChannel) {
          await writeFile(
            resolve(root, ".secrets/windows-validation-feed.json"),
            JSON.stringify(
              {
                channel_id: channelId,
                channel_title: channelTitle,
                feed_url: `${origin}/feed/${channel.feed_token}.xml`,
                media_url: url,
                episode_id: episode.id,
              },
              null,
              2,
            ),
            { mode: 0o600 },
          );
          result.channel_retained = true;
        }
        console.log(
          "PASS: running Windows executor -> real YouTube -> audio -> private R2 -> RSS -> FFprobe",
        );
        break;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
    }
    if (result.status === "not-run") {
      result.status = "timeout";
      process.exitCode = 2;
      console.log(
        "The conversion did not finish within the smoke-test window.",
      );
    }
  } else result.status = "connected";
} catch (error) {
  result.status = "error";
  result.error = error.message;
  process.exitCode = 1;
  console.error(error.message, error.cause?.code || "");
} finally {
  if (channelId && !(keepChannel && result.status === "passed")) {
    try {
      await api(`/api/channels/${channelId}`, undefined, "DELETE");
      result.test_channel_removed = true;
    } catch {
      result.test_channel_removed = false;
      console.error(
        "The temporary channel still has active work; clean it up after its lease expires.",
      );
    }
  }
  if (cookie)
    try {
      await api("/api/auth/logout", {});
    } catch {}
  await writeFile(
    resolve(stateDir, "smoke-result.json"),
    JSON.stringify(result, null, 2),
  );
}
