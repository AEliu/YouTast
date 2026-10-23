// Set an invitation secret without putting its value in arguments or terminal output.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, ".secrets");
const file = resolve(directory, "production.env");
await mkdir(directory, { recursive: true, mode: 0o700 });
let invitation;
try {
  const content = await readFile(file, "utf8");
  const match = content.match(/^REGISTRATION_INVITE=([a-f0-9]{64})\s*$/);
  if (!match)
    throw new Error(
      "Existing production.env has an unexpected format; inspect it locally.",
    );
  invitation = match[1];
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  invitation = randomBytes(32).toString("hex");
  await writeFile(file, `REGISTRATION_INVITE=${invitation}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}

const child = spawn(
  process.execPath,
  [resolve(root, "node_modules/wrangler/bin/wrangler.js"), "secret", "bulk"],
  {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);
let stdout = "",
  stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdin.on("error", () => {});
child.stdin.end(JSON.stringify({ REGISTRATION_INVITE: invitation }));
const code = await new Promise((resolveExit, reject) => {
  child.on("error", reject);
  child.on("close", resolveExit);
});
for (const [stream, output] of [
  [process.stdout, stdout],
  [process.stderr, stderr],
]) {
  stream.write(output.replaceAll(invitation, "[redacted]"));
}
if (code !== 0) process.exitCode = code || 1;
else console.log(`Invitation configured. Read it locally from: ${file}`);
