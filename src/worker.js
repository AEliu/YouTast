import {audioMedia} from './audio.js';
import {channelDetail} from './channel-detail.js';
import {userCollection} from './listing.js';
import {changePassword} from './passwords.js';
import {adminApi} from "./admin.js";
import {subscriptionPage} from './subscribe.js';
import {seedLegacyInvite} from './invitations.js';
import {executionPolicy,validateExecution} from './execution.js';
import {reconcileWindow} from './episode-window.js';
import {makeSpace,cleanupOverQuota} from './storage-policy.js';
import {scanRecords} from './scan-records.js';
import {
  now,
  id,
  secret,
  hash,
  passwordHash,
  youtubeSource,
  makeFeed,
  HttpError,
  requireValue,
} from "./lib.js";
import { SORT_MODES, sortEpisodes, effectiveSortMode } from "./sorting.js";
import { DEFAULT_SETTINGS, SETTING_OPTIONS, SETTING_RANGES, TEXT_LANGUAGES, validateSettings, imageUrl, cleanMetadata, audioProfile } from "./preferences.js";

const json = (data, status = 200, headers = {}) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const allStorageBytes = `SELECT COALESCE(SUM(size),0) FROM (
  SELECT object_key,MAX(size) size FROM (
    SELECT object_key,size FROM episodes WHERE object_key IS NOT NULL
    UNION ALL SELECT object_key,size FROM object_gc
  ) GROUP BY object_key
)`;
const userStorageBytes = `SELECT COALESCE(SUM(size),0) FROM (
  SELECT object_key,MAX(size) size FROM (
    SELECT e.object_key,e.size FROM episodes e JOIN channels c ON c.id=e.channel_id
      WHERE c.user_id=? AND e.object_key IS NOT NULL
    UNION ALL SELECT object_key,size FROM object_gc WHERE user_id=?
  ) GROUP BY object_key
)`;
async function body(request, maxSize = 65536) {
  requireValue(
    Number(request.headers.get("content-length") || 0) <= maxSize,
    413,
    "请求过大",
  );
  const reader = request.body?.getReader();
  requireValue(reader, 400, "缺少请求内容");
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxSize) {
      await reader.cancel();
      throw new HttpError(413, "请求过大");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(bytes);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("Expected a JSON object");
    return parsed;
  } catch {
    throw new HttpError(400, "JSON 格式错误");
  }
}
async function userFor(request, env) {
  const token = request.headers
    .get("cookie")
    ?.match(/(?:^|;\s*)session=([a-f0-9]{64})(?:;|$)/)?.[1];
  requireValue(token, 401, "请先登录");
  const user = await stmt(
    env,
    "SELECT u.id,u.username,u.settings,u.role,u.storage_limit_bytes,u.monthly_transfer_limit_bytes FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0",
    await hash(token),
    now(),
  ).first();
  requireValue(user, 401, "登录已过期");
  return user;
}
async function executorFor(request, env) {
  const token = request.headers
    .get("authorization")
    ?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  requireValue(token, 401, "执行器密钥无效");
  const executor = await stmt(
    env,
    "SELECT x.id,x.user_id,x.minimum_protocol FROM executors x JOIN users u ON u.id=x.user_id WHERE x.token_hash=? AND u.disabled=0",
    await hash(token),
  ).first();
  requireValue(executor, 401, "执行器密钥无效");
  return executor;
}
async function ownedChannel(env, user, channelId) {
  const channel = await stmt(
    env,
    "SELECT * FROM channel_preferences WHERE id=? AND user_id=?",
    channelId,
    user.id,
  ).first();
  requireValue(channel, 404, "频道不存在");
  return channel;
}
async function rateLimit(request, env) {
  const key = await hash(request.headers.get("cf-connecting-ip") || "local");
  const row = await stmt(
    env,
    `INSERT INTO login_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END, reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count`,
    key,
    now() + 900,
    now(),
    now(),
  ).first();
  requireValue(row.count <= 15, 429, "尝试过于频繁，请 15 分钟后再试");
}
async function auth(request, env, path) {
  if (path === "/api/auth/logout") {
    const token = request.headers
      .get("cookie")
      ?.match(/(?:^|;\s*)session=([a-f0-9]{64})/)?.[1];
    if (token)
      await stmt(
        env,
        "DELETE FROM sessions WHERE token_hash=?",
        await hash(token),
      ).run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie(request, "", 0) });
  }
  await rateLimit(request, env);
  const b = await body(request);
  requireValue(
    typeof b.username === "string" && /^[a-zA-Z0-9_-]{3,40}$/.test(b.username),
    400,
    "用户名需为 3–40 位字母、数字、下划线或连字符",
  );
  requireValue(
    typeof b.password === "string" &&
      b.password.length >= 12 &&
      b.password.length <= 128,
    400,
    "密码需为 12–128 个字符",
  );
  const username = b.username.toLowerCase();
  let user;
  if (path === "/api/auth/register") {
    const registration=await stmt(env,"SELECT registration_enabled FROM app_config WHERE id=1").first();
    requireValue(registration.registration_enabled===1,403,"当前未开放注册，请联系管理员");
    requireValue(typeof b.invite==='string'&&b.invite.trim().length>0&&b.invite.length<=160,403,'邀请码无效、已停用、已过期或次数已用完');
    await seedLegacyInvite(env);
    const invitation=await stmt(env,'SELECT id FROM invitations WHERE code_hash=?',await hash(b.invite.trim())).first();
    requireValue(invitation,403,'邀请码无效、已停用、已过期或次数已用完');
    const salt = secret(),
      uid = id(),
      pass = await passwordHash(b.password, salt);
    let result;
    try {result = await stmt(
      env,
      "INSERT INTO users(id,username,salt,password_hash,created_at,invite_id) VALUES(?,?,?,?,?,?) RETURNING id",
      uid,
      username,
      salt,
      pass,
      now(),
      invitation.id,
    ).first();}catch(error){
      const message=String(error.message);
      if(message.includes('invite_unavailable'))throw new HttpError(403,'邀请码无效、已停用、已过期或次数已用完');
      if(message.includes('registration_closed'))throw new HttpError(403,'当前未开放注册，请联系管理员');
      if(message.includes('UNIQUE constraint failed: users.username'))throw new HttpError(409,'该用户名不可用');
      throw error;
    }
    requireValue(result?.id === uid, 409, "该用户名不可用");
    user = { id: uid, username, salt, password_hash:pass };
  } else {
    user = await stmt(
      env,
      "SELECT * FROM users WHERE username=?",
      username,
    ).first();
    const pass = await passwordHash(
      b.password,
      user?.salt || "dummy-salt-to-normalize-login",
    );
    requireValue(user && pass === user.password_hash, 401, "用户名或密码错误");
    requireValue(!user.disabled,403,"账号已停用，请联系管理员");
  }
  const token = secret();
  const session=await stmt(
    env,
    "INSERT INTO sessions(token_hash,user_id,expires_at) SELECT ?,id,? FROM users WHERE id=? AND salt=? AND password_hash=? AND disabled=0 RETURNING token_hash",
    await hash(token),
    now() + 604800,
    user.id,
    user.salt,
    user.password_hash,
  ).first();
  requireValue(session,401,'账号凭据已变更，请重新登录');
  return json({ user: { id: user.id, username: user.username } }, 200, {
    "Set-Cookie": cookie(request, token, 604800),
  });
}
function cookie(request, token, age) {
  return `session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

async function schedule(env, owner = null) {
  const t = now();
  await env.DB.batch([
    stmt(env, `UPDATE episodes SET object_key=NULL,size=0,expired_at=?,cleanup_reason='retention' WHERE id IN (
      SELECT e.id FROM episodes e JOIN channel_preferences p ON p.id=e.channel_id
      WHERE e.object_key IS NOT NULL AND p.retention_days>0 AND e.ready_at<=?-p.retention_days*86400
      AND (? IS NULL OR p.user_id=?) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.episode_id=e.id AND j.status='running'))`, t,t,owner,owner),
    stmt(env, `UPDATE jobs SET status='failed',error='音频保留期已到，已自动清理',updated_at=? WHERE status='done'
      AND episode_id IN(SELECT e.id FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE e.expired_at IS NOT NULL AND e.cleanup_reason='retention' AND e.object_key IS NULL AND (? IS NULL OR c.user_id=?))`,t,owner,owner),
    stmt(
      env,
      `UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END, error='执行器租约过期', lease_token=NULL,lease_until=NULL,executor_id=NULL,reserved_bytes=0,available_at=?,updated_at=? WHERE status='running' AND lease_until<?`,
      t + 60,
      t,
      t,
    ),
    stmt(
      env,
      `INSERT OR IGNORE INTO jobs(id,user_id,channel_id,source_id,kind,available_at,created_at,updated_at) SELECT lower(hex(randomblob(16))),c.user_id,s.channel_id,s.id,'scan',?,?,? FROM sources s JOIN channels c ON c.id=s.channel_id JOIN users u ON u.id=c.user_id WHERE u.disabled=0 AND s.next_scan<=? AND (? IS NULL OR c.user_id=?) AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.source_id=s.id AND j.status IN ('queued','running')) ORDER BY s.next_scan,s.id LIMIT 20`,
      t,
      t,
      t,
      t,
      owner,
      owner,
    ),
    stmt(env, "DELETE FROM sessions WHERE expires_at<?", t),
    stmt(env, "DELETE FROM login_limits WHERE reset_at<?", t),
    stmt(env,"DELETE FROM usage_daily WHERE day<date('now','-13 months')"),
  ]);
}

async function cleanupObjects(env, owner = null) {
  // Physical deletion is retriable. Keep its reservation until R2 confirms it.
  for (let batch = 0; batch < 4; batch++) {
    const rows = await stmt(
      env,
      `SELECT g.object_key FROM object_gc g
      WHERE g.not_before<=? AND (? IS NULL OR g.user_id=?)
      AND NOT EXISTS(SELECT 1 FROM episodes e WHERE e.object_key=g.object_key)
      AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.id=g.job_id AND j.lease_token=g.lease_token AND j.status='running' AND j.lease_until>?)
      ORDER BY g.not_before,g.object_key LIMIT 50`,
      now(),
      owner,
      owner,
      now(),
    ).all();
    const keys = rows.results.map((row) => row.object_key);
    if (!keys.length) return;
    try {
      await env.AUDIO.delete(keys);
      await stmt(
        env,
        `DELETE FROM object_gc WHERE object_key IN (${keys.map(() => "?").join(",")})`,
        ...keys,
      ).run();
    } catch (error) {
      console.error("Audio cleanup deferred:", error.name);
      return;
    }
  }
}

async function api(request, env, url) {
  const path = url.pathname,
    method = request.method;
  if (path.startsWith("/api/executor/")) return executorApi(request, env, url);
  if (method !== "GET")
    requireValue(
      request.headers.get("origin") === url.origin,
      403,
      "请求来源无效",
    );
  if (
    ["/api/auth/login", "/api/auth/register", "/api/auth/logout"].includes(
      path,
    ) &&
    method === "POST"
  )
    return auth(request, env, path);
  const user = await userFor(request, env);
  if(path.startsWith("/api/admin/"))return adminApi(request,env,url,user,body,allStorageBytes,rateLimit);
  if(path==='/api/auth/password'&&method==='POST'){
    await rateLimit(request,env);
    await changePassword(env,user,await body(request));
    return json({ok:true},200,{'Set-Cookie':cookie(request,'',0)});
  }
  if(path==='/api/execution-policy') {
    if(method==='GET')return json(await executionPolicy(env,user.id));
    if(method==='POST') {
      const b=validateExecution(await body(request));
      await stmt(env,`INSERT INTO execution_policy(user_id,concurrency,start_interval,request_interval,download_wait,cooldown_seconds,paused)
       VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET concurrency=excluded.concurrency,start_interval=excluded.start_interval,
       request_interval=excluded.request_interval,download_wait=excluded.download_wait,cooldown_seconds=excluded.cooldown_seconds,paused=excluded.paused,
       next_start_at=MAX(0,next_start_at-start_interval+excluded.start_interval)`,user.id,b.concurrency,b.start_interval,b.request_interval,b.download_wait,b.cooldown_seconds,b.paused?1:0).run();
      return json({ok:true,policy:await executionPolicy(env,user.id)});
    }
  }
  if(path==='/api/execution-policy/resume'&&method==='POST') {
    await stmt(env,'UPDATE execution_policy SET paused=0,cooldown_until=0 WHERE user_id=?',user.id).run();
    return json({ok:true});
  }
  if(path === "/api/settings") {
    if(method === "GET") return json({settings:{...DEFAULT_SETTINGS,...JSON.parse(user.settings)},options:SETTING_OPTIONS,ranges:SETTING_RANGES});
    if(method === "POST") {
      const b=await body(request), settings=validateSettings(b.settings);
      await stmt(env,"UPDATE users SET settings=? WHERE id=?",JSON.stringify(settings),user.id).run();
      await reconcileWindow(env,null,user.id);
      await makeSpace(env,user.id,0,cleanupObjects,allStorageBytes,userStorageBytes);
      return json({ok:true,settings:{...DEFAULT_SETTINGS,...settings}});
    }
  }
  if (path === "/api/me" && method === "GET") return json({ user });
  if((path==='/api/episodes'||path==='/api/jobs')&&method==='GET')return json(await userCollection(env,user,url,path.slice(5)));
  if (path === "/api/dashboard" && method === "GET") {
    const result = await env.DB.batch([
      stmt(
        env,
        `SELECT c.*, (SELECT COUNT(*) FROM episodes e WHERE e.channel_id=c.id AND e.object_key IS NOT NULL AND e.id IN(SELECT id FROM active_episode_window WHERE channel_id=c.id)) AS episode_count,(SELECT COUNT(*) FROM episodes e WHERE e.channel_id=c.id AND e.object_key IS NOT NULL AND e.id NOT IN(SELECT id FROM active_episode_window WHERE channel_id=c.id)) AS archived_count FROM channel_preferences c WHERE c.user_id=? ORDER BY c.created_at DESC`,
        user.id,
      ),
      stmt(
        env,
        `SELECT j.id,j.kind,j.status,j.attempts,j.reused,CASE WHEN j.status='done' THEN NULL ELSE j.error END AS error,j.created_at,j.updated_at,c.title channel_title,e.title episode_title FROM jobs j JOIN channels c ON c.id=j.channel_id LEFT JOIN episodes e ON e.id=j.episode_id WHERE j.user_id=? ORDER BY j.created_at DESC LIMIT 80`,
        user.id,
      ),
      stmt(
        env,
        `SELECT e.* FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE c.user_id=? AND e.id IN(SELECT id FROM active_episode_window WHERE channel_id=c.id) ORDER BY e.created_at DESC,e.id LIMIT 100`,
        user.id,
      ),
      stmt(
        env,
        "SELECT id,name,created_at,last_seen,rate_control_version,window_control_version,audio_control_version,replay_control_version FROM executors WHERE user_id=? ORDER BY created_at DESC",
        user.id,
      ),
      stmt(
        env,
        "SELECT s.* FROM sources s JOIN channels c ON c.id=s.channel_id WHERE c.user_id=? ORDER BY s.sort_order,s.id",
        user.id,
      ),
      stmt(
        env,
        `SELECT (${userStorageBytes}) bytes,(SELECT COUNT(*) FROM jobs WHERE user_id=? AND status IN ('queued','running')) active_jobs`,
        user.id,
        user.id,
        user.id,
      ),
      stmt(env,'SELECT * FROM app_config WHERE id=1'),
      stmt(env,"SELECT COALESCE(SUM(bytes),0) bytes FROM usage_daily WHERE user_id=? AND day>=date('now','start of month')",user.id),
    ]);
    return json({
      user: {id:user.id,username:user.username,role:user.role},
      settings: {...DEFAULT_SETTINGS,...JSON.parse(user.settings)},
      settingOptions: SETTING_OPTIONS,
      settingRanges: SETTING_RANGES,
      channels: result[0].results,
      jobs: result[1].results,
      episodes: result[2].results,
      executors: result[3].results,
      sources: result[4].results,
      bytes: result[5].results[0].bytes,
      activeJobs: result[5].results[0].active_jobs,
      maxUserBytes: user.storage_limit_bytes ?? result[6].results[0].default_user_storage_bytes ?? Number(env.MAX_USER_STORAGE_BYTES),
      transferBytes: result[7].results[0].bytes,
      maxUserTransferBytes: user.monthly_transfer_limit_bytes ?? result[6].results[0].default_monthly_transfer_bytes,
    });
  }
  if (path === "/api/channels" && method === "POST") {
    const b = await body(request);
    requireValue(
      typeof b.title === "string" &&
        b.title.trim().length > 0 &&
        b.title.length <= 100,
      400,
      "频道名称需为 1–100 个字符",
    );
    requireValue(
      typeof (b.description ?? "") === "string" &&
        (b.description || "").length <= 1000,
      400,
      "简介过长",
    );
    const count = await stmt(
      env,
      "SELECT COUNT(*) n FROM channels WHERE user_id=?",
      user.id,
    ).first();
    requireValue(count.n < Number(env.MAX_CHANNELS), 409, "已达到频道上限");
    const cid = id();
    await stmt(
      env,
      "INSERT INTO channels(id,user_id,title,description,feed_token,created_at) VALUES(?,?,?,?,?,?)",
      cid,
      user.id,
      b.title.trim(),
      b.description || "",
      secret(),
      now(),
    ).run();
    return json({ id: cid }, 201);
  }
  const sourceRoute = path.match(
    /^\/api\/channels\/([\w-]+)\/sources\/([\w-]+)$/,
  );
  if (sourceRoute && method === "DELETE") {
    const channel = await ownedChannel(env, user, sourceRoute[1]);
    // Cascading scan deletion revokes its lease. Existing episodes/transcodes stay.
    const removed = await stmt(
      env,
      "DELETE FROM sources WHERE id=? AND channel_id=? RETURNING id",
      sourceRoute[2],
      channel.id,
    ).first();
    requireValue(removed, 404, "来源不存在");
    return json({ ok: true });
  }
  const channelRoute = path.match(
    /^\/api\/channels\/([\w-]+)(?:\/(sources|rotate|sync|sort|settings|detail))?$/,
  );
  if (channelRoute) {
    const channel = await ownedChannel(env, user, channelRoute[1]);
    if(channelRoute[2]==='detail'&&method==='GET')return json(await channelDetail(env,channel,url));
    if(channelRoute[2] === "settings" && method === "POST") {
      const b=await body(request), settings=validateSettings(b.settings,true);
      requireValue(typeof b.title==='string'&&b.title.trim().length>0&&b.title.length<=100,400,'频道名称需为 1–100 个字符');
      requireValue(typeof b.description==='string'&&b.description.length<=1000,400,'频道简介过长');
      const rss=b.rss_metadata||{};
      requireValue(typeof rss.author==='string'&&rss.author.length<=200,400,'作者信息无效');
      requireValue(typeof rss.image==='string'&&(!rss.image||imageUrl(rss.image)),400,'封面需为 HTTPS 图片链接');
      requireValue((rss.language==='inherit'||TEXT_LANGUAGES.filter(v=>v!=='original').includes(rss.language))&&['Education','Technology','Business','Arts','Society & Culture','Leisure'].includes(rss.category)&&typeof rss.explicit==='boolean',400,'RSS 信息无效');
      await stmt(env,"UPDATE channels SET title=?,description=?,settings=?,rss_metadata=? WHERE id=?",b.title.trim(),b.description,JSON.stringify(settings),JSON.stringify({author:rss.author,image:rss.image,...(rss.language==='inherit'?{}:{language:rss.language}),category:rss.category,explicit:rss.explicit}),channel.id).run();
      await reconcileWindow(env,channel.id);
      return json({ok:true});
    }
    if (channelRoute[2] === "sort" && method === "POST") {
      const b = await body(request);
      requireValue(b.sort_mode === "inherit" || SORT_MODES.includes(b.sort_mode), 400, "不支持的排序方式");
      await stmt(env, b.sort_mode === "inherit" ? "UPDATE channels SET settings=json_remove(settings,'$.sort_mode') WHERE id=?" : "UPDATE channels SET settings=json_set(settings,'$.sort_mode',?) WHERE id=?", ...(b.sort_mode === "inherit" ? [channel.id] : [b.sort_mode,channel.id])).run();
      return json({ ok: true });
    }
    if (channelRoute[2] === "rotate" && method === "POST") {
      await stmt(
        env,
        "UPDATE channels SET feed_token=? WHERE id=?",
        secret(),
        channel.id,
      ).run();
      return json({ ok: true });
    }
    if (channelRoute[2] === "sources" && method === "POST") {
      const b = await body(request);
      requireValue(
        Array.isArray(b.urls) &&
          b.urls.length > 0 &&
          b.urls.length <= 10 &&
          b.urls.every((x) => typeof x === "string" && x.length <= 500),
        400,
        "一次可添加 1–10 条链接",
      );
      let parsed;
      try {
        requireValue(b.include_replays==null||typeof b.include_replays==='boolean',400,'直播回放选项无效');
        parsed = b.urls.map(youtubeSource).flatMap(s=>b.include_replays&&s.kind==='author'&&s.url.endsWith('/videos')?[s,{...s,url:s.url.replace(/\/videos$/,'/streams')}]:[s]);
      } catch (e) {
        throw new HttpError(400, e.message);
      }
      const requestedCount=parsed.length;
      const existing = await stmt(
        env,
        "SELECT url FROM sources WHERE channel_id=?",
        channel.id,
      ).all();
      const existingUrls = new Set(existing.results.map((s) => s.url));
      parsed = [...new Map(parsed.map((s) => [s.url, s])).values()].filter(
        (s) => !existingUrls.has(s.url),
      );
      requireValue(
        existingUrls.size + parsed.length <= 30,
        409,
        "每个频道最多 30 个来源",
      );
      const statements = [],
        sourceIndexes = [],
        reuseIndexes = [];
      for (const s of parsed) {
        sourceIndexes.push(statements.length);
        statements.push(
          stmt(
            env,
            `INSERT OR IGNORE INTO sources(id,channel_id,url,kind,next_scan,created_at,sort_order)
            VALUES(?,?,?,?,?,?,1+MAX(COALESCE((SELECT MAX(sort_order) FROM sources WHERE channel_id=?),0),COALESCE((SELECT MAX(source_order) FROM episodes WHERE channel_id=?),0)))`,
            id(),
            channel.id,
            s.url,
            s.kind,
            now(),
            now(),
            channel.id,
            channel.id,
          ),
        );
        if (s.kind === "video") {
          const videoId = new URL(s.url).searchParams.get("v");
          reuseIndexes.push(statements.length);
          statements.push(
            stmt(
              env,
              `INSERT OR IGNORE INTO episodes(id,channel_id,video_id,title,duration,object_key,size,created_at,published_at,source_order,source_kind,source_position,added_position,metadata,encoding_profile,ready_at)
            SELECT ?,?,?,cached.title,cached.duration,cached.object_key,cached.size,?,cached.published_at,
              (SELECT sort_order FROM sources WHERE channel_id=? AND url=?),'video',1,1
              ,cached.metadata,cached.encoding_profile,unixepoch()
            FROM episodes cached JOIN channels owner ON owner.id=cached.channel_id
            WHERE owner.user_id=? AND cached.video_id=? AND cached.object_key IS NOT NULL AND cached.encoding_profile=? AND COALESCE(json_extract(cached.metadata,'$.text_language'),'zh-CN')=?
            ORDER BY cached.created_at,cached.id LIMIT 1`,
              id(),
              channel.id,
              videoId,
              now(),
              channel.id,
              s.url,
              user.id,
              videoId,
              audioProfile(channel),
              channel.text_language,
            ),
          );
          statements.push(
            stmt(
              env,
              `UPDATE sources SET next_scan=? WHERE channel_id=? AND url=?
            AND EXISTS(SELECT 1 FROM episodes e WHERE e.channel_id=sources.channel_id AND e.video_id=? AND e.object_key IS NOT NULL)`,
              now() + 315360000,
              channel.id,
              s.url,
              videoId,
            ),
          );
        }
      }
      let results = [];
      try {
        if (statements.length) results = await env.DB.batch(statements);
      } catch (error) {
        if (String(error.message).includes("source_limit"))
          throw new HttpError(409, "每个频道最多 30 个来源");
        throw error;
      }
      const added = sourceIndexes.reduce(
        (n, i) => n + results[i].meta.changes,
        0,
      );
      const reused = reuseIndexes.reduce(
        (n, i) => n + results[i].meta.changes,
        0,
      );
      if (added) await schedule(env, user.id);
      return json(
        { ok: true, added, duplicates: requestedCount - added, reused },
        added ? 201 : 200,
      );
    }
    if (channelRoute[2] === "sync" && method === "POST") {
      await stmt(
        env,
        "UPDATE sources SET next_scan=? WHERE channel_id=?",
        now(),
        channel.id,
      ).run();
      await schedule(env, user.id);
      return json({ ok: true });
    }
    if (!channelRoute[2] && method === "DELETE") {
      // No live upload may be in progress while removing a channel.
      const removed = await stmt(
        env,
        "DELETE FROM channels WHERE id=? AND user_id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE channel_id=? AND status='running') RETURNING id",
        channel.id,
        user.id,
        channel.id,
      ).first();
      requireValue(
        removed,
        409,
        "频道仍有执行中的任务，请等任务完成或租约过期",
      );
      await cleanupObjects(env, user.id);
      return json({ ok: true });
    }
  }
  if (path === "/api/executors" && method === "POST") {
    const b = await body(request);
    requireValue(
      typeof b.name === "string" &&
        b.name.trim().length > 0 &&
        b.name.length <= 60,
      400,
      "请输入执行器名称",
    );
    const count = await stmt(
      env,
      "SELECT COUNT(*) n FROM executors WHERE user_id=?",
      user.id,
    ).first();
    requireValue(count.n < 10, 409, "最多创建 10 个执行器");
    const token = secret(),
      eid = id();
    await stmt(
      env,
      "INSERT INTO executors(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,?)",
      eid,
      user.id,
      b.name.trim(),
      await hash(token),
      now(),
    ).run();
    return json({ id: eid, token }, 201);
  }
  const executorRoute = path.match(/^\/api\/executors\/([\w-]+)$/);
  if (executorRoute && method === "DELETE") {
    await stmt(
      env,
      "DELETE FROM executors WHERE id=? AND user_id=?",
      executorRoute[1],
      user.id,
    ).run();
    await stmt(
      env,
      "UPDATE jobs SET status='queued',executor_id=NULL,lease_token=NULL,lease_until=NULL,reserved_bytes=0,available_at=? WHERE executor_id=? AND user_id=? AND status='running'",
      now() + 60,
      executorRoute[1],
      user.id,
    ).run();
    return json({ ok: true });
  }
  const retry = path.match(/^\/api\/jobs\/([\w-]+)\/retry$/);
  if (retry && method === "POST") {
    await stmt(
      env,
      "UPDATE jobs SET status='queued',attempts=0,error=NULL,available_at=?,updated_at=? WHERE id=? AND user_id=? AND status='failed'",
      now(),
      now(),
      retry[1],
      user.id,
    ).run();
    return json({ ok: true });
  }
  const episodeRetry = path.match(/^\/api\/episodes\/([\w-]+)\/retry$/);
  if(episodeRetry&&method==='POST') {
    const e=await stmt(env,'SELECT e.id,e.channel_id FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE e.id=? AND c.user_id=?',episodeRetry[1],user.id).first();
    requireValue(e,404,'单集不存在');
    const result=await env.DB.batch([
      stmt(env,`INSERT OR IGNORE INTO jobs(id,user_id,channel_id,episode_id,kind,available_at,created_at,updated_at)
        SELECT ?,?,?,?,'transcode',?,?,? WHERE EXISTS(SELECT 1 FROM episodes WHERE id=? AND object_key IS NULL)`,id(),user.id,e.channel_id,e.id,now(),now(),now(),e.id),
      stmt(env,`UPDATE jobs SET status='queued',attempts=0,error=NULL,available_at=?,updated_at=? WHERE episode_id=? AND user_id=? AND status IN('failed','done')
        AND EXISTS(SELECT 1 FROM episodes WHERE id=? AND object_key IS NULL)`,now(),now(),e.id,user.id,e.id),
    ]);
    requireValue(result.some(r=>r.meta.changes>0),409,'音频仍可用或任务已在处理中');
    return json({ok:true});
  }
  const epRoute = path.match(/^\/api\/episodes\/([\w-]+)$/);
  if (epRoute && method === "DELETE") {
    const e = await stmt(
      env,
      "SELECT e.* FROM episodes e JOIN channels c ON c.id=e.channel_id WHERE e.id=? AND c.user_id=?",
      epRoute[1],
      user.id,
    ).first();
    requireValue(e, 404, "单集不存在");
    // Keep the episode identity to prevent reimport; clearing storage allows an explicit retry.
    const removed = await env.DB.batch([
      stmt(
        env,
        "UPDATE episodes SET object_key=NULL,size=0,expired_at=unixepoch(),cleanup_reason='manual' WHERE id=? AND NOT EXISTS(SELECT 1 FROM jobs WHERE episode_id=? AND status='running') RETURNING id",
        e.id,
        e.id,
      ),
      stmt(
        env,
        "UPDATE jobs SET status='failed',error='音频已由用户删除' WHERE episode_id=? AND status!='running'",
        e.id,
      ),
    ]);
    // D1 changes also includes GC trigger writes; RETURNING identifies the
    // episode update itself without mistaking a successful delete for a 409.
    requireValue(removed[0].results.length === 1, 409, "请等待转码完成");
    await cleanupObjects(env, user.id);
    return json({ ok: true });
  }
  throw new HttpError(404, "接口不存在");
}

async function executorApi(request, env, url) {
  const executor = await executorFor(request, env),
    path = url.pathname,
    t = now();
  requireValue(request.method === "POST", 405, "仅支持 POST");
  if(path==='/api/executor/status') {
    const status=await stmt(env,"SELECT id,name,last_seen AS lastSeen,rate_control_version AS rateControlVersion,window_control_version AS windowControlVersion,audio_control_version AS audioControlVersion,replay_control_version AS replayControlVersion,(SELECT COUNT(*) FROM jobs WHERE executor_id=executors.id AND user_id=? AND status='running' AND lease_until>?) AS activeJobs FROM executors WHERE id=?",executor.user_id,t,executor.id).first();
    return json({...status,minimumProtocol:executor.minimum_protocol});
  }
  if (path === "/api/executor/claim") {
    if(Number(request.headers.get('x-executor-protocol')||1)<executor.minimum_protocol)
      return json({job:null,retryAfter:300,upgradeRequired:true});
    // Reclaim only the current owner's expired leases; UPDATE RETURNING arbitrates concurrent machines.
    await env.DB.batch([
      stmt(env, "UPDATE executors SET last_seen=?,rate_control_version=?,window_control_version=?,audio_control_version=?,replay_control_version=? WHERE id=?", t,request.headers.get('x-executor-rate-control')==='1'?1:0,request.headers.get('x-executor-content-control')==='1'?1:0,request.headers.get('x-executor-audio-control')==='1'?1:0,request.headers.get('x-executor-replay-control')==='1'?1:0, executor.id),
      stmt(
        env,
        "UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,lease_token=NULL,executor_id=NULL,reserved_bytes=0,error='执行器租约过期',available_at=?,updated_at=? WHERE user_id=? AND status='running' AND lease_until<?",
        t + 60,
        t,
        executor.user_id,
        t,
      ),
      // Reuse only this owner's completed audio, entirely inside the transaction.
      // No stale key is read into JS where a concurrent last-reference delete could race it.
      stmt(
        env,
        `UPDATE episodes AS pending SET (object_key,size,duration,published_at,metadata,encoding_profile,ready_at,expired_at,title)=(
        SELECT cached.object_key,cached.size,cached.duration,COALESCE(cached.published_at,pending.published_at),CASE WHEN COALESCE(json_extract(cached.metadata,'$.text_language'),'zh-CN')=(SELECT text_language FROM channel_preferences WHERE id=pending.channel_id) THEN cached.metadata ELSE pending.metadata END,cached.encoding_profile,unixepoch(),NULL,CASE WHEN COALESCE(json_extract(cached.metadata,'$.text_language'),'zh-CN')=(SELECT text_language FROM channel_preferences WHERE id=pending.channel_id) THEN cached.title ELSE pending.title END FROM episodes cached
        JOIN channels owner ON owner.id=cached.channel_id WHERE owner.user_id=?
          AND cached.video_id=pending.video_id AND cached.object_key IS NOT NULL AND cached.encoding_profile=(SELECT audio_profile FROM channel_preferences WHERE id=pending.channel_id)
        ORDER BY (COALESCE(json_extract(cached.metadata,'$.text_language'),'zh-CN')=(SELECT text_language FROM channel_preferences WHERE id=pending.channel_id)) DESC,cached.created_at,cached.id LIMIT 1)
        WHERE pending.object_key IS NULL
        AND EXISTS(SELECT 1 FROM jobs j WHERE j.episode_id=pending.id AND j.user_id=? AND j.kind='transcode' AND j.status='queued')
        AND EXISTS(SELECT 1 FROM episodes cached JOIN channels owner ON owner.id=cached.channel_id
          WHERE owner.user_id=? AND cached.video_id=pending.video_id AND cached.object_key IS NOT NULL AND cached.encoding_profile=(SELECT audio_profile FROM channel_preferences WHERE id=pending.channel_id))`,
        executor.user_id,
        executor.user_id,
        executor.user_id,
      ),
      stmt(
        env,
        `UPDATE jobs SET status='done',reused=1,error=NULL,lease_token=NULL,executor_id=NULL,reserved_bytes=0,updated_at=?
        WHERE user_id=? AND kind='transcode' AND status='queued'
        AND EXISTS(SELECT 1 FROM episodes e JOIN channel_preferences p ON p.id=e.channel_id WHERE e.id=jobs.episode_id AND e.object_key IS NOT NULL
            AND COALESCE(json_extract(e.metadata,'$.text_language'),'zh-CN')=p.text_language AND COALESCE(json_extract(e.metadata,'$.complete'),1)=1)`,
        t,
        executor.user_id,
      ),
    ]);
    const policy=await executionPolicy(env,executor.user_id);
    const delay=Math.max(0,policy.next_start_at-t,policy.cooldown_until-t);
    if(policy.paused||delay>0)return json({job:null,retryAfter:policy.paused?60:Math.max(1,delay),execution:policy});
    const token = secret();
    let job;
    try {job = await stmt(
      env,
      `UPDATE jobs SET status='running',encoding_profile=COALESCE((SELECT encoding_profile FROM episodes WHERE id=jobs.episode_id AND object_key IS NOT NULL),(SELECT audio_profile FROM channel_preferences WHERE id=jobs.channel_id)),attempts=attempts+1,error=NULL,lease_token=?,executor_id=?,lease_until=?,updated_at=? WHERE id=(
        SELECT candidate.id FROM jobs candidate LEFT JOIN episodes target ON target.id=candidate.episode_id JOIN channel_preferences policy ON policy.id=candidate.channel_id
        WHERE candidate.user_id=? AND candidate.status='queued' AND candidate.available_at<=?
        AND ((policy.latest_limit=0 AND policy.scan_limit IN(10,30,50,100)) OR ?=1)
        AND (candidate.kind!='scan' OR ?=1 OR NOT EXISTS(SELECT 1 FROM sources replay WHERE replay.id=candidate.source_id AND (replay.waiting_replay=1 OR replay.url LIKE '%/streams')))
        AND (candidate.kind='scan' OR target.object_key IS NOT NULL OR policy.audio_mode='mp3' OR ?=1)
        AND (candidate.kind='scan' OR EXISTS(SELECT 1 FROM active_episode_window w WHERE w.id=candidate.episode_id))
        AND (candidate.kind='scan' OR policy.latest_limit=0 OR NOT EXISTS(SELECT 1 FROM jobs scan WHERE scan.channel_id=candidate.channel_id AND scan.kind='scan' AND scan.status IN('queued','running')))
        AND (?=1 OR (policy.bitrate=64 AND policy.text_language IN ('zh-CN','original') AND policy.scan_limit=30 AND (candidate.kind='scan' OR target.object_key IS NULL)))
        AND (candidate.kind='scan' OR target.object_key IS NOT NULL OR NOT EXISTS(SELECT 1 FROM jobs running JOIN episodes active ON active.id=running.episode_id
          WHERE running.user_id=candidate.user_id AND running.kind='transcode' AND running.status='running'
          AND running.lease_until>? AND active.video_id=target.video_id)
          AND NOT EXISTS(SELECT 1 FROM episodes completed JOIN channels owner ON owner.id=completed.channel_id
            WHERE owner.user_id=candidate.user_id AND completed.video_id=target.video_id AND completed.object_key IS NOT NULL AND completed.encoding_profile=policy.audio_profile))
        ORDER BY candidate.created_at,candidate.id LIMIT 1) AND status='queued' RETURNING *`,
      token,
      executor.id,
      t + 600,
      t,
      executor.user_id,
      t,
      request.headers.get('x-executor-content-control')==='1'?1:0,
      request.headers.get('x-executor-replay-control')==='1'?1:0,
      request.headers.get('x-executor-audio-control')==='1'?1:0,
      request.headers.get("x-executor-protocol") === "2" ? 1 : 0,
      t,
    ).first();}catch(error){
      if(!String(error.message).includes('execution_throttled'))throw error;
      const current=await executionPolicy(env,executor.user_id);
      return json({job:null,retryAfter:current.paused?60:Math.max(15,current.next_start_at-t,current.cooldown_until-t),execution:current});
    }
    if (!job) return json({ job: null, retryAfter: 60,execution:policy });
    const source = job.source_id
      ? await stmt(
          env,
        "SELECT url,kind FROM sources WHERE id=?",
          job.source_id,
        ).first()
      : null;
    const episode = job.episode_id
      ? await stmt(
          env,
          "SELECT video_id,title,(object_key IS NOT NULL) AS metadata_only FROM episodes WHERE id=?",
          job.episode_id,
        ).first()
      : null;
    const preferences = await stmt(env,"SELECT bitrate,audio_mode,text_language,MAX(scan_limit,latest_limit) scan_limit,latest_limit,sync_hours FROM channel_preferences WHERE id=?",job.channel_id).first();
    const [,bitrate]=job.encoding_profile.split(":");
    return json({
      job: { id: job.id, kind: job.kind, leaseToken: token, source, episode, options:{...preferences,bitrate:Number(bitrate),encoding_profile:job.encoding_profile,metadata_only:Boolean(episode?.metadata_only),execution:policy} },
      execution:policy,
      retryAfter: 0,
    });
  }
  const m = path.match(
    /^\/api\/executor\/jobs\/([\w-]+)\/(heartbeat|scan|audio|fail|metadata)$/,
  );
  requireValue(m, 404, "接口不存在");
  const lease = request.headers.get("x-lease-token") || "";
  const job = await stmt(
    env,
    "SELECT * FROM jobs WHERE id=? AND user_id=? AND executor_id=? AND status='running' AND lease_token=? AND lease_until>?",
    m[1],
    executor.user_id,
    executor.id,
    lease,
    t,
  ).first();
  requireValue(job, 409, "任务租约已失效");
  if(m[2] === "metadata") {
    requireValue(job.kind==='transcode',409,'任务类型不匹配');
    const b=await body(request,131072), metadata=cleanMetadata(b.metadata);
    requireValue(b.title==null||(typeof b.title==='string'&&b.title.length>0&&b.title.length<=300),400,'节目标题无效');
    requireValue(b.published_at==null||(Number.isInteger(b.published_at)&&b.published_at>0&&b.published_at<=t+86400),400,'发布日期无效');
    const result=await stmt(env,`UPDATE episodes SET metadata=?,title=COALESCE(?,title),published_at=COALESCE(?,published_at) WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?)`,JSON.stringify(metadata),b.title??null,b.published_at??null,job.episode_id,job.id,lease,t).run();
    requireValue(result.meta.changes===1,409,'任务租约已失效');
    if(b.complete_job===true) {
      const done=await stmt(env,`UPDATE jobs SET status='done',reused=1,error=NULL,lease_token=NULL,executor_id=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_until>? AND EXISTS(SELECT 1 FROM episodes WHERE id=jobs.episode_id AND object_key IS NOT NULL)`,t,job.id,lease,t).run();
      requireValue(done.meta.changes===1,409,'只能完成已有音频的元数据任务');
    }
    return json({ok:true});
  }
  if (m[2] === "heartbeat") {
    await env.DB.batch([
      stmt(
        env,
        "UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND lease_token=? AND status='running'",
        t + 600,
        t,
        job.id,
        lease,
      ),
      stmt(env, "UPDATE executors SET last_seen=? WHERE id=?", t, executor.id),
    ]);
    return json({ ok: true });
  }
  if (m[2] === "fail") {
    const b = await body(request);
    if(b.defer_replay===true) {
      requireValue(job.kind==='transcode',409,'仅音频任务可等待回放');
      const preferences=await stmt(env,'SELECT sync_hours FROM channel_preferences WHERE id=?',job.channel_id).first();
      await stmt(env,"UPDATE jobs SET status='queued',attempts=MAX(0,attempts-1),error='直播回放尚未就绪，按频道间隔等待重试',available_at=?,lease_token=NULL,executor_id=NULL,reserved_bytes=0,updated_at=? WHERE id=? AND lease_token=? AND status='running' AND lease_until>?",t+3600*preferences.sync_hours,t,job.id,lease,t).run();
      return json({ok:true,deferred:true});
    }
    const failure=String(b.error||'处理失败').slice(0,500);
    if(/requires verification|cookies are no longer valid|cookies have expired|rate limiting|HTTP 403/.test(failure)) {
      await stmt(env,`INSERT INTO execution_policy(user_id,cooldown_until) VALUES(?,?+1800)
       ON CONFLICT(user_id) DO UPDATE SET cooldown_until=MAX(cooldown_until,?+cooldown_seconds)`,executor.user_id,t,t).run();
    }
    await stmt(
      env,
      "UPDATE jobs SET status=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,error=?,available_at=?,lease_token=NULL,executor_id=NULL,reserved_bytes=0,updated_at=? WHERE id=? AND lease_token=? AND status='running'",
      String(b.error || "处理失败").slice(0, 500),
      t + Math.min(3600, 60 * 2 ** job.attempts),
      t,
      job.id,
      lease,
    ).run();
    return json({ ok: true });
  }
  if (m[2] === "scan") {
    requireValue(job.kind === "scan", 409, "任务类型不匹配");
    const b = await body(request,262144);
    requireValue(
      Array.isArray(b.entries) && b.entries.length <= 100,
      400,
      "每次扫描最多 100 条",
    );
    for (const e of b.entries)
      requireValue(
        e &&
          typeof e.video_id === "string" &&
          /^[\w-]{11}$/.test(e.video_id) &&
          typeof e.title === "string" &&
          e.title.length <= 300 &&
          Number.isInteger(e.duration) &&
          e.duration >= 0 &&
          e.duration <= 86400 &&
          (e.published_at == null || (Number.isInteger(e.published_at) && e.published_at > 0 && e.published_at <= t + 86400)) &&
          (e.position == null || (Number.isInteger(e.position) && e.position > 0 && e.position <= 1000000)),
        400,
        "视频信息无效",
      );
    const live =
      "EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?)";
    const seen = new Set();
    const entries = b.entries.map((e, index) => ({ ...e, position: e.position ?? index + 1 }))
      .filter(e => { if (seen.has(e.video_id)) return false; seen.add(e.video_id); return true; });
    const statements = [scanRecords(env,job,lease,entries,t)];
    if(request.headers.get('x-executor-protocol')==='2') statements.push(stmt(env, `UPDATE jobs SET status='queued',reused=1,attempts=0,error=NULL,available_at=?,updated_at=?
      WHERE channel_id=? AND kind='transcode' AND status='done' AND EXISTS(SELECT 1 FROM episodes e
      WHERE e.id=jobs.episode_id AND e.object_key IS NOT NULL AND json_extract(e.metadata,'$.complete')=0) AND ${live}`,t,t,job.channel_id,job.id,lease,t));
    statements.push(
      stmt(
        env,
        `INSERT OR IGNORE INTO jobs(id,user_id,channel_id,episode_id,kind,available_at,created_at,updated_at) SELECT lower(hex(randomblob(16))),?,e.channel_id,e.id,'transcode',?,?,? FROM episodes e WHERE e.channel_id=? AND e.object_key IS NULL AND e.expired_at IS NULL AND e.id IN(SELECT id FROM active_episode_window) AND ${live}`,
        job.user_id,
        t,
        t,
        t,
        job.channel_id,
        job.id,
        lease,
        t,
      ),
    );
    statements.push(
      stmt(
        env,
        `UPDATE sources SET waiting_replay=CASE WHEN kind='video' AND ?=1 THEN 1 ELSE 0 END,next_scan=CASE WHEN kind='video' AND ?=0 THEN ? ELSE ? END WHERE id=? AND ${live}`,
        entries.length===0?1:0,
        entries.length===0?1:0,
        t + 315360000,
        t + 3600 * (await stmt(env,"SELECT sync_hours FROM channel_preferences WHERE id=?",job.channel_id).first()).sync_hours,
        job.source_id,
        job.id,
        lease,
        t,
      ),
    );
    statements.push(
      stmt(
        env,
        "UPDATE jobs SET status='done',error=NULL,lease_token=NULL,executor_id=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running' AND lease_until>?",
        t,
        job.id,
        lease,
        t,
      ),
    );
    await env.DB.batch(statements);
    await reconcileWindow(env,job.channel_id);
    return json({ ok: true });
  }
  requireValue(job.kind === "transcode", 409, "任务类型不匹配");
  const bytes = Number(request.headers.get("content-length"));
  requireValue(
    Number.isSafeInteger(bytes) &&
      bytes > 0 &&
      bytes <= Number(env.MAX_AUDIO_BYTES),
    413,
    "音频超过单文件上限或缺少 Content-Length",
  );
  const media=audioMedia({object_key:job.encoding_profile.startsWith("m4a:")?"audio.m4a":"audio.mp3"});
  requireValue(request.headers.get("content-type") === media.mime,415,"音频格式与任务不匹配");
  const duration = Number(request.headers.get("x-audio-duration") || 0);
  const publishedAt = Number(request.headers.get("x-published-at")) || null;
  requireValue(publishedAt === null || (Number.isInteger(publishedAt) && publishedAt > 0 && publishedAt <= t + 86400), 400, "发布日期无效");
  requireValue(
    Number.isInteger(duration) && duration >= 0 && duration <= 86400,
    400,
    "时长无效",
  );
  const key = `${job.user_id}/${job.channel_id}/${job.episode_id}/${lease}.${media.extension}`;
  const reserve = () => stmt(
    env,
    `INSERT OR IGNORE INTO object_gc(object_key,user_id,size,not_before,job_id,lease_token,created_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?) AND
    (${allStorageBytes})+?<=COALESCE((SELECT max_storage_bytes FROM app_config WHERE id=1),?) AND
    (${userStorageBytes})+?<=COALESCE((SELECT storage_limit_bytes FROM users WHERE id=?),(SELECT default_user_storage_bytes FROM app_config WHERE id=1),?) RETURNING object_key`,
    key,
    job.user_id,
    bytes,
    t + 1200,
    job.id,
    lease,
    t,
    job.id,
    lease,
    t,
    bytes,
    Number(env.MAX_STORAGE_BYTES),
    executor.user_id,
    executor.user_id,
    bytes,
    executor.user_id,
    Number(env.MAX_USER_STORAGE_BYTES),
  ).first();
  let reserved=await reserve();
  if(!reserved) {
    const active=await stmt(env,"SELECT id FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?",job.id,lease,now()).first();
    const uploading=await stmt(env,'SELECT object_key FROM object_gc WHERE object_key=?',key).first();
    if(active&&!uploading)await makeSpace(env,job.user_id,bytes,cleanupObjects,allStorageBytes,userStorageBytes);
    reserved=await reserve();
  }
  requireValue(reserved, 409, "存储额度不足或该任务正在上传");
  const uploadAbort = new AbortController();
  const uploadDeadline = setTimeout(
    () => uploadAbort.abort(new Error("音频上传超时")),
    600000,
  );
  try {
    const limited = new FixedLengthStream(bytes);
    const [object] = await Promise.all([
      env.AUDIO.put(key, limited.readable, {
        httpMetadata: { contentType: media.mime },
      }),
      request.body.pipeTo(limited.writable, { signal: uploadAbort.signal }),
    ]);
    requireValue(object && object.size === bytes, 400, "音频上传不完整");
    const completedAt = now();
    const results = await env.DB.batch([
      stmt(
        env,
        "UPDATE episodes SET object_key=?,size=?,encoding_profile=?,ready_at=unixepoch(),expired_at=NULL,cleanup_reason=NULL,duration=CASE WHEN ?>0 THEN ? ELSE duration END,published_at=COALESCE(?,published_at) WHERE id=? AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND lease_token=? AND status='running' AND lease_until>?)",
        key,
        bytes,
        job.encoding_profile,
        duration,
        duration,
        publishedAt,
        job.episode_id,
        job.id,
        lease,
        completedAt,
      ),
      stmt(
        env,
        "UPDATE jobs SET status='done',reserved_bytes=0,lease_token=NULL,executor_id=NULL,error=NULL,updated_at=? WHERE id=? AND lease_token=? AND status='running' AND lease_until>?",
        completedAt,
        job.id,
        lease,
        completedAt,
      ),
      stmt(
        env,
        "DELETE FROM object_gc WHERE object_key=? AND EXISTS(SELECT 1 FROM episodes WHERE object_key=?) AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND status='done')",
        key,
        key,
        job.id,
      ),
    ]);
    requireValue(
      results[0].meta.changes === 1 &&
        results[1].meta.changes === 1 &&
        results[2].meta.changes === 1,
      409,
      "上传时租约失效",
    );
    await reconcileWindow(env,job.channel_id);
    return json({ ok: true });
  } catch (e) {
    try {
      const referenced = await stmt(
        env,
        "SELECT id FROM episodes WHERE object_key=?",
        key,
      ).first();
      if (!referenced) {
        await env.AUDIO.delete(key);
        await stmt(env, "DELETE FROM object_gc WHERE object_key=?", key).run();
      }
    } catch (cleanupError) {
      // The durable intent remains counted toward quota and the Cron retries it.
      console.error("Upload cleanup deferred:", cleanupError.name);
    }
    throw e;
  } finally {
    clearTimeout(uploadDeadline);
  }
}

async function feed(request, env, url) {
  const m = url.pathname.match(
    /^\/(feed|media|chapters)\/([a-f0-9]{64})(?:\.xml|\/([\w-]+)\.(?:mp3|m4a|json))$/,
  );
  requireValue(m, 404, "链接不存在");
  requireValue(
    request.method === "GET" || request.method === "HEAD",
    405,
    "仅支持 GET / HEAD",
  );
  const channel = await stmt(
    env,
    "SELECT * FROM channel_preferences WHERE feed_token=? AND user_id IN(SELECT id FROM users WHERE disabled=0)",
    m[2],
  ).first();
  requireValue(channel, 404, "链接不存在或已撤销");
  if(m[1]==='chapters' && m[3] && url.pathname.endsWith('.json')) {
    const e=await stmt(env,'SELECT metadata FROM episodes WHERE id=? AND channel_id=? AND object_key IS NOT NULL',m[3],channel.id).first();
    requireValue(e,404,'章节不存在');
    const chapters=JSON.parse(e.metadata).chapters||[];
    return new Response(request.method==='HEAD'?null:JSON.stringify({version:'1.2.0',chapters}),{headers:{'Content-Type':'application/json+chapters; charset=utf-8','Cache-Control':'private, no-store'}});
  }
  if (m[1] === "feed" && !m[3]) {
    const episodes = await stmt(
      env,
      "SELECT * FROM episodes WHERE channel_id=? AND object_key IS NOT NULL AND id IN(SELECT id FROM active_episode_window)",
      channel.id,
    ).all();
    return new Response(
      request.method === "HEAD"
        ? null
        : makeFeed({...channel,sort_mode:effectiveSortMode(channel)}, sortEpisodes(episodes.results, effectiveSortMode(channel)).slice(0, channel.feed_limit), url.origin),
      {
        headers: {
          "Content-Type": "application/rss+xml; charset=utf-8",
          "Cache-Control": "private, no-store",
        },
      },
    );
  }
  requireValue(m[1] === "media" && m[3] && (/\.(mp3|m4a)$/.test(url.pathname)), 404, "链接不存在");
  const episode = await stmt(
    env,
    "SELECT object_key FROM episodes WHERE id=? AND channel_id=? AND object_key IS NOT NULL",
    m[3],
    channel.id,
  ).first();
  requireValue(episode, 404, "音频不存在");
  const meta = await env.AUDIO.head(episode.object_key);
  requireValue(meta, 404, "音频不存在");
  const headers = new Headers({
    "Content-Type": audioMedia(episode).mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    ETag: meta.httpEtag,
  });
  let offset = 0,
    length = meta.size,
    status = 200;
  const range = request.headers.get("range");
  if (
    range &&
    (!request.headers.get("if-range") ||
      request.headers.get("if-range") === meta.httpEtag)
  ) {
    const r = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!r || (!r[1] && !r[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${meta.size}` },
      });
    if (!r[1]) {
      length = Math.min(Number(r[2]), meta.size);
      offset = meta.size - length;
    } else {
      offset = Number(r[1]);
      length =
        (r[2] ? Math.min(Number(r[2]), meta.size - 1) : meta.size - 1) -
        offset +
        1;
    }
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      offset >= meta.size ||
      length <= 0
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${meta.size}` },
      });
    status = 206;
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${meta.size}`,
    );
  }
  headers.set("Content-Length", String(length));
  const chargedBytes=request.method==='HEAD'?0:length;
  const charged=await stmt(env,`INSERT INTO usage_daily(user_id,day,bytes,requests)
    SELECT ?,date('now'),?,1 WHERE
    (COALESCE((SELECT monthly_transfer_limit_bytes FROM users WHERE id=?),(SELECT default_monthly_transfer_bytes FROM app_config WHERE id=1))=0
     OR (SELECT COALESCE(SUM(bytes),0) FROM usage_daily WHERE user_id=? AND day>=date('now','start of month'))+?<=COALESCE((SELECT monthly_transfer_limit_bytes FROM users WHERE id=?),(SELECT default_monthly_transfer_bytes FROM app_config WHERE id=1)))
    AND ((SELECT max_monthly_transfer_bytes FROM app_config WHERE id=1)=0
     OR (SELECT COALESCE(SUM(bytes),0) FROM usage_daily WHERE day>=date('now','start of month'))+?<=(SELECT max_monthly_transfer_bytes FROM app_config WHERE id=1))
    ON CONFLICT(user_id,day) DO UPDATE SET bytes=bytes+excluded.bytes,requests=requests+1 RETURNING user_id,day`,channel.user_id,chargedBytes,channel.user_id,channel.user_id,chargedBytes,channel.user_id,chargedBytes).first();
  if(!charged) {
    const d=new Date(),reset=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1);
    return json({error:'本月音频流量额度已用完，请联系管理员'},429,{'Retry-After':String(Math.max(1,Math.ceil((reset-Date.now())/1000)))});
  }
  let object=null;
  try {
    if(request.method!=='HEAD') {
      object=await env.AUDIO.get(episode.object_key,{range:{offset,length}});
      requireValue(object,404,'音频不存在');
    }
  } catch(error) {
    await stmt(env,"UPDATE usage_daily SET bytes=MAX(0,bytes-?),requests=MAX(0,requests-1) WHERE user_id=? AND day=?",chargedBytes,channel.user_id,charged.day).run();
    throw error;
  }
  return new Response(object?.body || null, { status, headers });
}
export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      let response;
      if (url.pathname.startsWith("/api/"))
        response = await api(request, env, url);
      else if(url.pathname.startsWith('/subscribe/')) {
        requireValue(['GET','HEAD'].includes(request.method),405,'方法不支持');
        const token=url.pathname.match(/^\/subscribe\/([a-f0-9]{64})$/)?.[1];
        requireValue(token,404,'订阅链接无效或已失效');
        const channel=await stmt(env,'SELECT c.title,c.feed_token FROM channels c JOIN users u ON u.id=c.user_id WHERE c.feed_token=? AND u.disabled=0',token).first();
        requireValue(channel,404,'订阅链接无效或已失效');
        response=new Response(request.method==='HEAD'?null:subscriptionPage(channel,url.origin,url.searchParams.get('client')),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow, noarchive'}});
      }
      else if (
        url.pathname.startsWith("/feed/") ||
        url.pathname.startsWith("/media/") || url.pathname.startsWith("/chapters/")
      )
        response = await feed(request, env, url);
      else response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "no-referrer");
      headers.set("X-Frame-Options", "DENY");
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://i.ytimg.com https://yt3.ggpht.com https://yt3.googleusercontent.com; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      headers.set(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
      );
      return new Response(response.body, { status: response.status, headers });
    } catch (e) {
      if (!(e instanceof HttpError)) console.error("Request failed:", e.name);
      return json(
        {
          error:
            e instanceof HttpError ? e.message : "服务暂时不可用，请稍后再试",
        },
        e instanceof HttpError ? e.status : 500,
        {
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
        },
      );
    }
  },
  async scheduled(_event, env) {
    await schedule(env);
    await cleanupObjects(env);
    await cleanupOverQuota(env,cleanupObjects,allStorageBytes,userStorageBytes);
  },
};
