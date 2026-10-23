// Provision a dedicated local account and executor. Secrets never enter arguments or output.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".secrets");
const ownerPath = resolve(directory, "windows-owner.env");
const executorPath = resolve(directory, "windows-executor.env");
const savedOwner = await readFile(ownerPath, "utf8").catch(error => { if(error.code === "ENOENT") return ""; throw error; });
const originUrl = new URL(process.env.YOUTAST_URL || savedOwner.match(/^YOUTAST_URL=(.+)$/m)?.[1] || "");
if(originUrl.protocol !== "https:" || originUrl.username || originUrl.password || originUrl.pathname !== "/" || originUrl.search || originUrl.hash) throw new Error("Set YOUTAST_URL to your HTTPS application origin");
const origin = originUrl.origin;
await mkdir(directory, { recursive: true, mode: 0o700 });
const parse = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const i = line.indexOf("=");
        if (i < 1) throw new Error("Invalid private environment file");
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
const serialize = (values) =>
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
async function existing(path) {
  try {
    return parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
const invite = (await existing(resolve(directory, "production.env")))
  ?.REGISTRATION_INVITE;
if (!/^[a-f0-9]{64}$/.test(invite || ""))
  throw new Error("Production invitation is not configured");
let owner = await existing(ownerPath);
if (!owner) {
  owner = {
    YOUTAST_URL: origin,
    YOUTAST_USERNAME: process.env.YOUTAST_USERNAME || "executor_owner",
    YOUTAST_PASSWORD: randomBytes(32).toString("hex"),
  };
  await writeFile(ownerPath, serialize(owner), { mode: 0o600, flag: "wx" });
}
if (
  owner.YOUTAST_URL !== origin ||
  !/^[a-zA-Z0-9_-]{3,40}$/.test(owner.YOUTAST_USERNAME || "") ||
  !owner.YOUTAST_PASSWORD ||
  owner.YOUTAST_PASSWORD.length < 12
)
  throw new Error(
    "Inspect the existing owner configuration locally; it has an unexpected format",
  );
let cookie = "";
async function request(path, data, method = "POST") {
  const response = await fetch(origin + path, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(data || {}),
  });
  const body = await response.json();
  return { response, body };
}
const credentials = {
  username: owner.YOUTAST_USERNAME,
  password: owner.YOUTAST_PASSWORD,
};
let login = await request("/api/auth/login", credentials);
if (login.response.status === 401) {
  login = await request("/api/auth/register", { ...credentials, invite });
  if (login.response.status === 409)
    throw new Error(
      "The configured account name already exists with different credentials; no existing account was changed",
    );
}
if (!login.response.ok)
  throw new Error(
    `Initial account setup failed (HTTP ${login.response.status})`,
  );
cookie = login.response.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("No session was returned");
try {
  const dashboard = await request("/api/dashboard", undefined, "GET");
  if (!dashboard.response.ok)
    throw new Error("Could not inspect the local account's executors");
  let executor = await existing(executorPath);
  const reusable =
    executor &&
    executor.YOUTAST_URL === origin &&
    /^[a-f0-9]{64}$/.test(executor.YOUTAST_TOKEN || "") &&
    dashboard.body.executors.some(
      (item) => item.id === executor.YOUTAST_EXECUTOR_ID,
    );
  if (!reusable) {
    const created = await request("/api/executors", {
      name: `Windows-${process.env.COMPUTERNAME || "local"}`.slice(0, 60),
    });
    if (
      !created.response.ok ||
      !/^[a-f0-9]{64}$/.test(created.body.token || "")
    )
      throw new Error(
        `Executor creation failed (HTTP ${created.response.status})`,
      );
    executor = {
      YOUTAST_URL: origin,
      YOUTAST_TOKEN: created.body.token,
      YOUTAST_EXECUTOR_ID: created.body.id,
      YOUTAST_USERNAME: owner.YOUTAST_USERNAME,
    };
    await writeFile(executorPath, serialize(executor), { mode: 0o600 });
  }
  console.log(`Local application account: ${owner.YOUTAST_USERNAME}`);
  console.log(`Account credentials saved locally: ${ownerPath}`);
  console.log(`Executor configuration saved locally: ${executorPath}`);
  console.log("No passwords or tokens were printed.");
} finally {
  await request("/api/auth/logout", {});
}
