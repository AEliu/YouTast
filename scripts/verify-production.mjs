// Run the normal integration contract against our deployed HTTPS origin.
// Temporary test users are removed by their exact, unique names afterward.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = new URL(process.argv[2] || process.env.YOUTAST_URL || "");
if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
  throw new Error("Provide the HTTPS origin of this deployed application.");
const secret = (await readFile(resolve(root, ".secrets/production.env"), "utf8")).match(/^REGISTRATION_INVITE=([a-f0-9]{64})\s*$/)?.[1];
if (!secret) throw new Error("Configure the production invitation before running this check.");
const suffix = Date.now().toString(36) + "_" + randomBytes(4).toString("hex");
async function run(args, env = process.env) {
  const child = spawn(process.execPath, args, {cwd:root, env, stdio:["ignore","pipe","pipe"], windowsHide:true});
  let output="";
  child.stdout.on("data",chunk=>{output+=chunk});
  child.stderr.on("data",chunk=>{output+=chunk});
  const code=await new Promise((resolveExit,reject)=>{child.on("error",reject);child.on("close",resolveExit)});
  return {code, output:output.replaceAll(secret,"[redacted]")};
}
let check;
try {
  check=await run(["--test",resolve(root,"tests/integration.mjs")],{...process.env,TEST_ORIGIN:origin.origin,TEST_INVITE:secret,TEST_RUN_SUFFIX:suffix});
  process.stdout.write(check.output);
  await mkdir(resolve(root,"test-results"),{recursive:true});
  await writeFile(resolve(root,"test-results/production-verification.txt"),check.output);
} finally {
  // Names are generated here, never supplied by the caller. No real user is targeted.
  const cleanup=await run([resolve(root,"node_modules/wrangler/bin/wrangler.js"),"d1","execute","DB","--remote","--command",`DELETE FROM users WHERE username IN ('alice_${suffix}','bob_${suffix}')`]);
  if(cleanup.code!==0) {
    process.stderr.write("Temporary test-user cleanup failed; inspect the following result locally.\n"+cleanup.output);
    process.exitCode=1;
  } else console.log("Temporary production test accounts removed.");
}
if(check?.code!==0)process.exitCode=check?.code || 1;
