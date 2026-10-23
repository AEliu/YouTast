import { readApiResponse } from "./api-response.js";
import {renderAdmin,adminUserFields,limitBytes,invitationFields} from './admin-ui.js';
import {subscriptionLinks,podcastClients} from './subscribe-links.js';
import {renderExecution} from './execution-ui.js';

const $ = (s) => document.querySelector(s),
  escape = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let data = null,
  executionData = null,
  adminData = null,
  view = "channels",
  register = false,
  refreshing = false,
  retryAt = 0,
  retryMessage = "";
const sortNames = { source: "按来源自动排序", published_asc: "发布时间：从早到晚", published_desc: "发布时间：从晚到早", added_asc: "加入顺序：先加入在前", added_desc: "加入顺序：后加入在前" };
const statusNames = {
  queued: "等待处理",
  running: "处理中",
  done: "已完成",
  failed: "失败",
};
const viewInfo = {
  channels: ["我的频道", "把值得一听的内容，放进自己的声音世界。"],
  episodes: ["声音资料库", "所有准备好的声音，都在这里。"],
  jobs: ["任务队列", "从发现内容到转成声音，每一步都有迹可循。"],
  executors: ["执行器", "让不同机器共同处理你的音频任务。"],
  settings: ["用户设置", "把收听偏好设为默认，各频道仍可单独调整。"],
  admin: ['管理后台','管理账号、存储和音频流量。'],
};
async function api(path, options = {}) {
  if (Date.now() < retryAt) throw new Error(retryMessage);
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    credentials: "same-origin",
  });
  try {
    return await readApiResponse(response);
  } catch (error) {
    if (error.status === 401 && !path.startsWith("/api/auth/")) showAuth();
    if (error.retryAfterMs) {
      retryAt = Date.now() + error.retryAfterMs;
      retryMessage = error.message;
    }
    throw error;
  }
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 4200);
}
function showAuth() {
  $("#initial").hidden = true;
  $("#app").hidden = true;
  $("#auth").hidden = false;
  data = null;
  adminData = null;
  executionData = null;
}
async function refresh() {
  if (refreshing || Date.now() < retryAt) return;
  refreshing = true;
  try {
    data = await api("/api/dashboard");
    if(view==='executors')executionData=await api('/api/execution-policy');
    if(view==='admin'&&data.user.role!=='admin'){view='channels';adminData=null;}
    $("#initial").hidden = true;
    $("#auth").hidden = true;
    $("#app").hidden = false;
    render();
  } catch (e) {
    if (!data) {
      showAuth();
      if (e.status !== 401) $("#auth-error").textContent = e.message;
    } else toast(e.message);
  } finally {
    refreshing = false;
  }
}
function render() {
  $('#admin-nav').hidden=data.user.role!=='admin';
  $("#username").textContent = data.user.username;
  $("#avatar").textContent = data.user.username[0].toUpperCase();
  $("#nav-count").textContent = data.channels.length;
  $("#page-title").innerHTML = `${viewInfo[view][0]}<span>.</span>`;
  $("#page-description").textContent = viewInfo[view][1];
  $("#breadcrumb").textContent = `工作空间 / ${viewInfo[view][0]}`;
  document
    .querySelectorAll("[data-view]")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $("#new-channel").hidden = view !== "channels";
  $("#stats").hidden = view !== "channels";
  $("#stat-channels").innerHTML = `${data.channels.length}<small>个</small>`;
  $("#stat-episodes").innerHTML =
    `${data.channels.reduce((n, c) => n + c.episode_count, 0)}<small>集</small>`;
  $("#stat-jobs").innerHTML = `${data.activeJobs}<small>项</small>`;
  $("#stat-storage").innerHTML =
    `${(data.bytes / 1e6).toFixed(1)}<small>MB / ${(data.maxUserBytes / 1e9).toFixed(0)} GB</small>`;
  const content = $("#content");
  if(view==='admin')content.innerHTML=renderAdmin(adminData);
  if (view === "channels")
    content.innerHTML = `<div class="section-bar"><strong>你的订阅频道 <small> / ${String(data.channels.length).padStart(2, "0")}</small></strong><small>只有你决定听什么</small></div><div class="grid">${data.channels.map((c, i) => `<article class="channel-card"><div class="channel-art art-${i % 5}"><span class="art-tag">PRIVATE PODCAST</span><span class="art-symbol" aria-hidden="true">${["◉", "≋", "∿", "◎", "✳"][i % 5]}</span><span class="art-corner">YOUTAST ORIGINAL SPACE</span></div><div class="card-body"><h3>${escape(c.title)}</h3><p>${escape(c.description || "留给好内容的一方声音空间。")}</p><div class="card-meta"><span>${c.episode_count} 集声音${c.archived_count?` · ${c.archived_count} 集旧音频仍保留缓存`:""} · ${data.sources.filter((s) => s.channel_id === c.id).length} 个来源</span><span>私人频道 ↗</span></div><div class="card-actions"><button class="small-button" data-action="sources" data-id="${c.id}">＋ 来源</button><button class="small-button" data-action="rss" data-id="${c.id}">▦ 扫码订阅</button><button class="small-button" data-action="channel-settings" data-id="${c.id}">频道设置</button><button class="small-button" data-action="sort" data-id="${c.id}">排序</button><button class="small-button" data-action="sync" data-id="${c.id}">同步</button><button class="small-button danger" data-action="delete-channel" data-id="${c.id}">删除</button></div></div></article>`).join("")}<button class="add-card" data-action="new-channel"><span>＋</span><strong>开始一个新的声音频道</strong><small>视频 / Playlist / 创作者</small></button></div><div class="intro-strip"><div class="intro-icon">♫</div><div><strong>把你的频道，带到喜欢的 Podcast 播放器。</strong><p>添加 YouTube 来源 → 连接执行器 → 等待音频生成 → 使用私人 RSS 订阅。订阅链接是访问凭证，请妥善保管。</p></div></div>`;
  if (view === "episodes")
    content.innerHTML = `<div class="section-bar"><strong>最近 100 集</strong><small>删除音频可释放存储空间</small></div>${
      data.episodes.length
        ? `<div class="list">${data.episodes
            .map((e) => {
              const c = data.channels.find((c) => c.id === e.channel_id);
              return `<article class="list-row"><div class="list-icon">♫</div><div class="list-details"><strong>${escape(e.title)}</strong><p>${escape(c?.title)} · ${Math.floor(e.duration / 60)} 分钟 · ${e.object_key ? `${(e.size / 1e6).toFixed(1)} MB` : (e.expired_at ? (e.cleanup_reason==="quota"?"空间不足已清理":e.cleanup_reason==="manual"?"已手动删除":"已按保留期清理") : "等待音频")}</p></div><button class="small-button" data-action="episode-details" data-id="${e.id}">简介 / 章节</button>${e.object_key ? `<audio controls preload="none" data-audio-id="${e.id}" src="/media/${c.feed_token}/${e.id}.mp3"></audio><button class="small-button danger" data-action="delete-episode" data-id="${e.id}">删除音频</button>` : (e.expired_at ? `<button class="small-button" data-action="regenerate" data-id="${e.id}">重新生成</button>` : '<span class="badge queued">待处理</span>')}</article>`;
            })
            .join("")}</div>`
        : empty("还没有单集。为频道添加来源，并运行执行器，声音就会来到这里。")
    }`;
  if (view === "jobs")
    content.innerHTML = `<div class="section-bar"><strong>最近 80 项任务</strong><small>租约 10 分钟 · 最多自动尝试 3 次</small></div>${data.jobs.length ? `<div class="list">${data.jobs.map((j) => `<article class="list-row"><div class="list-icon">${j.kind === "scan" ? "⌕" : "♫"}</div><div class="list-details"><strong>${escape(j.episode_title || j.channel_title)}</strong><p>${j.kind === "scan" ? "发现视频" : "转换音频"} · ${j.reused ? "已复用已有音频" : `已尝试 ${j.attempts} 次`}${j.error ? ` · ${escape(j.error)}` : ""}</p></div><span class="badge ${j.status}">${statusNames[j.status]}</span>${j.status === "failed" ? `<button class="small-button" data-action="retry" data-id="${j.id}">重试</button>` : ""}</article>`).join("")}</div>` : empty("暂无任务。添加频道来源后，执行器会领取扫描和转码任务。")}`;
  if (view === "settings") content.innerHTML = renderSettings();
  if (view === "executors")
    content.innerHTML = `${renderExecution(executionData)}<div class="section-bar"><strong>我的机器 <small> / 每个密钥只允许访问你的任务</small></strong><div class="section-actions"><a class="small-button" href="/install.html" target="_blank" rel="noopener">安装说明 ↗</a><a class="small-button" href="/downloads/youtast-executor-0.1.0.zip" download>下载执行器 ↓</a><button class="primary" data-action="new-executor">＋ 连接执行器</button></div></div>${data.executors.length ? `<div class="list">${data.executors.map((e) => `<article class="list-row"><div class="list-icon">⌘</div><div class="list-details"><strong>${escape(e.name)}</strong><p>${e.last_seen&&(e.rate_control_version!==1||e.window_control_version!==1)?"旧版本：请升级执行器以使用请求间隔、自定义候选数及最新N。 · ":""}${e.last_seen ? `最后连接：${new Date(e.last_seen * 1000).toLocaleString("zh-CN")}` : "尚未连接 · 请在机器上启动 Python 执行器"}</p></div><span class="badge">${e.last_seen && Date.now() / 1000 - e.last_seen < 400 ? "最近在线" : "等待连接"}</span><button class="small-button danger" data-action="revoke" data-id="${e.id}">撤销密钥</button></article>`).join("")}</div>` : empty("还没有连接机器。创建执行器密钥，然后在你的电脑或服务器上运行 Python 执行器。")}<div class="intro-strip"><div class="intro-icon">⌘</div><div><strong>一台机器也可以，多台机器更从容。</strong><p>机器主动访问 Cloudflare，无需开放入站端口。点击安装说明下载执行器并启动；每台机器使用独立密钥。</p></div></div>`;
}
function empty(text) {
  return `<div class="empty">${text}</div>`;
}
async function loadAdmin(offset=adminData?.offset||0,search=adminData?.search||'',inviteOffset=adminData?.inviteOffset||0) {
 const [overview,list,invites]=await Promise.all([api('/api/admin/overview'),api(`/api/admin/users?offset=${offset}&search=${encodeURIComponent(search)}`),api(`/api/admin/invitations?offset=${inviteOffset}`)]);
 adminData={overview,...list,search,invites:invites.invitations,inviteOffset:invites.offset,inviteHasMore:invites.hasMore};if(view==='admin')render();
}
$('#content').addEventListener('submit',async event=>{
 if(event.target.id==='execution-policy-form') {
  event.preventDefault();const form=new FormData(event.target),button=event.submitter;
  if(button)button.disabled=true;
  try {
   const payload={concurrency:Number(form.get('concurrency')),start_interval:Number(form.get('start_interval')),request_interval:Number(form.get('request_interval')),download_wait:Number(form.get('download_wait')),cooldown_seconds:Number(form.get('cooldown_minutes'))*60,paused:form.get('paused')==='true'};
   await api('/api/execution-policy',{method:'POST',body:JSON.stringify(payload)});await refresh();toast('请求控制已保存，后续任务生效');
  }catch(e){toast(e.message);}finally{if(button)button.disabled=false;}
  return;
 }
 if(!['admin-config-form','admin-search-form'].includes(event.target.id))return;
 event.preventDefault();const form=new FormData(event.target);
 try {
  if(event.target.id==='admin-search-form'){await loadAdmin(0,form.get('search'));return;}
  await api('/api/admin/config',{method:'POST',body:JSON.stringify({max_storage_bytes:limitBytes(form,'max_storage_bytes'),default_user_storage_bytes:limitBytes(form,'default_user_storage_bytes'),default_monthly_transfer_bytes:limitBytes(form,'default_monthly_transfer_bytes'),max_monthly_transfer_bytes:limitBytes(form,'max_monthly_transfer_bytes'),registration_enabled:form.get('registration_enabled')==='true'})});
  await loadAdmin();toast('站点设置已保存');
 }catch(e){toast(e.message);}
});
const preferenceLabels={retention_days:'保留天数（0 永久）',text_language:'标题 / 简介首选语言',bitrate:'MP3 码率',scan_limit:'每个来源候选数量',latest_limit:'合并全部来源取最新 N 条（0 不限制）',sync_hours:'同步间隔（小时）',feed_limit:'RSS 最多展示集数',sort_mode:'节目排序',storage_cleanup:'空间不足时清理音频'};
const languageLabels={original:'保留原文',zh:'中文',en:'English',ja:'日本語',ko:'한국어',es:'Español',fr:'Français',de:'Deutsch','zh-CN':'简体中文','zh-TW':'繁體中文'};
function optionLabel(key,value) {
  if(key==='sort_mode')return sortNames[value];
  if(key==='text_language')return languageLabels[value];
  if(key==='storage_cleanup')return value==='oldest'?'自动清理较旧音频':'关闭，空间不足时停止上传';
  if(key==='latest_limit'&&value===0)return '不限制';
  if(key==='retention_days')return value===0?'永久保留':`${value} 天`;
  if(key==='bitrate')return `${value} kbps${value===64?'（推荐语音）':''}`;
  if(key==='sync_hours')return `${value} 小时`;
  return `${value} 集`;
}
function preferenceFields(values,channel=false) {
  return Object.entries(data.settingOptions).filter(([key])=>!channel||!['rss_language','storage_cleanup'].includes(key)).map(([key,options])=>{
    const range=data.settingRanges?.[key];
    if(range)return `<label>${preferenceLabels[key]}<input name="${key}" type="number" min="${range.min}" max="${range.max}" step="1" ${channel?'':'required'} value="${values[key]??''}" placeholder="${channel?'留空跟随默认：'+data.settings[key]:range.min+'–'+range.max}"></label>`;
    return `<label>${preferenceLabels[key]}<select name="${key}">${channel?`<option value="inherit" ${values[key]===undefined?'selected':''}>跟随用户默认（${escape(optionLabel(key,data.settings[key]))}）</option>`:''}${options.map(v=>`<option value="${v}" ${v===values[key]?'selected':''}>${escape(optionLabel(key,v))}</option>`).join('')}</select></label>`;
  }).join('');
}
function formPreferences(form,channel=false) {
  const result={};
  for(const key of Object.keys(data.settingOptions)) {
    if(channel&&key==='rss_language')continue;
    const value=form.get(key);
    if(value===null||value==='inherit'||channel&&value==='')continue;
    result[key]=['retention_days','bitrate','scan_limit','latest_limit','sync_hours','feed_limit'].includes(key)?Number(value):value;
  }
  return result;
}
const policyHelp='<p class="muted">最新 N 条按本频道全部来源合并后的发布时间选取，不给每个作者固定分配名额；播放顺序仍按你选择的排序。旧音频退出列表后保留缓存，增加 N 可以重新显示。</p><details class="preference-help"><summary>数量范围与空间清理规则</summary><p>候选数量和最新N支持1–100；最新N设0关闭限制。保留天数0–3650（0永久），同步间隔1–168小时，RSS集数1–1000。频道中的数字留空则跟随用户默认。</p><p>会至少检查每个来源的N条候选，再合并筛选；作者取YouTube最新列表，playlist按列表顺序取候选。列表只有相对发布时间时按近似日期选择，完整信息回传后校准；没有日期的排后面。</p><p>自动空间清理默认关闭，只在用户设置开启。本人或全站空间不足时，优先清理本账号退出列表的音频，然后清理发布时间更早的音频；共享缓存的相关引用会一起清理，节目记录保留供手动重新生成。已有下载不会自动补抓；清理不减少已用流量，也不删除手机上的下载；RSS移出节目也不保证播放器删除收听历史。非0保留天数仍会按到期清理。</p><p>码率只影响新生成的音频，音轨保持视频默认。标题/简介优先使用YouTube已提供的设置语言，没有则保留原文。</p></details>';

function renderSettings() {
  return `<form id="settings-form" class="settings-panel"><h2>用户默认偏好</h2><p>未单独覆盖的频道跟随这里的设置；已有频道的排序选择保留。</p><div class="settings-grid">${preferenceFields(data.settings)}</div>${policyHelp}<p class="muted">本月音频请求字节：${(data.transferBytes/1e6).toFixed(2)} MB / ${data.maxUserTransferBytes ? (data.maxUserTransferBytes/1e9)+' GB' : '不限'}。登录会话有效期为 7 天。YouTube cookies 仅在执行器机器保存，不属于网页用户设置。</p><p id="settings-error" class="error" role="alert"></p><button class="primary">保存默认设置</button></form>`;
}
$('#content').addEventListener('submit',async event=>{
  if(event.target.id!=='settings-form')return;
  event.preventDefault();
  const button=event.target.querySelector('button');button.disabled=true;
  try {await api('/api/settings',{method:'POST',body:JSON.stringify({settings:formPreferences(new FormData(event.target))})});await refresh();toast('用户默认设置已保存');}
  catch(e){$('#settings-error').textContent=e.message;}
  finally{button.disabled=false;}
});
function openChannelSettings(channel) {
  const values=JSON.parse(channel.settings||'{}'),rss=JSON.parse(channel.rss_metadata||'{}');
  openDialog('频道与 RSS 设置',`<label>频道名称<input name="title" required maxlength="100" value="${escape(channel.title)}"></label><label>频道简介<textarea name="description" maxlength="1000">${escape(channel.description)}</textarea></label><label>RSS 作者<input name="author" maxlength="200" value="${escape(rss.author||'')}"></label><label>频道封面 HTTPS 链接<input name="image" type="url" maxlength="1000" value="${escape(rss.image||'')}" placeholder="https://…"></label><p class="muted">封面由 Podcast 播放器直接获取；建议使用你信任的图片地址。私人订阅无需填写公开邮箱。</p><label>RSS 语言<select name="rss_language"><option value="inherit">跟随用户默认</option>${data.settingOptions.text_language.filter(v=>v!=='original').map(v=>`<option value="${v}" ${v===rss.language?'selected':''}>${languageLabels[v]}</option>`).join('')}</select></label><label>RSS 分类<select name="category">${['Education','Technology','Business','Arts','Society & Culture','Leisure'].map(v=>`<option ${v===(rss.category||'Education')?'selected':''}>${v}</option>`).join('')}</select></label><label>成人内容标记<select name="explicit"><option value="false">否</option><option value="true" ${rss.explicit?'selected':''}>是</option></select></label><h3>本频道偏好</h3>${preferenceFields(values,true)}${policyHelp}`,'保存频道设置',async form=>{
    await api(`/api/channels/${channel.id}/settings`,{method:'POST',body:JSON.stringify({title:form.get('title'),description:form.get('description'),settings:formPreferences(form,true),rss_metadata:{author:form.get('author'),image:form.get('image'),language:form.get('rss_language'),category:form.get('category'),explicit:form.get('explicit')==='true'}})});
    toast('频道与 RSS 设置已保存');
  });
}
function openEpisodeDetails(episode) {
  const meta=JSON.parse(episode.metadata||'{}'),chapters=meta.chapters||[];
  const stamp=seconds=>`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
  openDialog(episode.title,`${meta.thumbnail?`<img class="episode-art" src="${escape(meta.thumbnail)}" alt="视频封面" referrerpolicy="no-referrer">`:''}<p>${escape(meta.author||'')}${episode.published_at?' · '+new Date(episode.published_at*1000).toLocaleDateString():''} · ${Math.floor(episode.duration/60)} 分钟</p><p><a href="https://www.youtube.com/watch?v=${episode.video_id}" target="_blank" rel="noopener noreferrer">打开原视频 ↗</a></p><div class="episode-notes">${escape(meta.description||'原视频简介尚未回传。已有音频不会仅为补简介而重新下载。')}</div><h3>章节</h3>${chapters.length?chapters.map(c=>`<button type="button" class="chapter-button" data-chapter-time="${c.startTime}" ${episode.object_key?'':'disabled'}>${stamp(c.startTime)} · ${escape(c.title)}</button>`).join(''):'<p>原视频未提供章节，或章节尚未回传。</p>'}`,'',()=>{});
  for(const button of $('#dialog-fields').querySelectorAll('[data-chapter-time]'))button.onclick=()=>{
    const audio=document.querySelector(`[data-audio-id="${episode.id}"]`);if(!audio)return;
    $('#dialog').close();
    const play=()=>{audio.currentTime=Number(button.dataset.chapterTime);audio.play().catch(()=>toast('请点击音频播放器开始播放'));};
    if(audio.readyState>=1)play();else{audio.addEventListener('loadedmetadata',play,{once:true});audio.load();}
  };
}
function openDialog(title, fields, submit, handler) {
  $("#dialog-title").textContent = title;
  $("#dialog-fields").innerHTML = fields;
  $("#dialog-error").textContent = "";
  $("#dialog-submit").textContent = submit;
  $("#dialog-submit").hidden = !submit;
  $("#dialog-submit").disabled = false;
  $("#dialog-form").onsubmit = async (event) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    $("#dialog-submit").disabled = true;
    try {
      const after=await handler(values);
      $("#dialog").close();
      await refresh();
      if(typeof after==='function')after();
    } catch (e) {
      $("#dialog-error").textContent = e.message;
    } finally {
      $("#dialog-submit").disabled = false;
    }
  };
  $("#dialog").showModal();
}
function newChannel() {
  openDialog(
    "创建你的声音频道",
    '<label>频道名称<input name="title" required maxlength="100" placeholder="例如：散步时的灵感"></label><label>频道简介<textarea name="description" maxlength="1000" placeholder="这个频道里，你想听什么？"></textarea></label>',
    "创建频道",
    async (f) => {
      await api("/api/channels", {
        method: "POST",
        body: JSON.stringify(Object.fromEntries(f)),
      });
      toast("频道已创建，接下来添加来源");
    },
  );
}
function openSources(channel) {
  const sources = data.sources.filter((s) => s.channel_id === channel.id);
  openDialog(
    "管理频道来源",
    `<p>支持单视频、playlist 或作者主页，每行一条。重复链接会自动跳过；同一用户已有的音频可直接复用。删除来源将停止后续扫描，已发现的单集和转换任务保留。</p>${sources.map((s) => `<div class="source-row"><span>${escape(s.url)}</span><button type="button" class="small-button danger" data-delete-source="${s.id}">删除来源</button></div>`).join("")}<label>添加来源<textarea name="urls" required placeholder="https://www.youtube.com/watch?v=…&#10;https://www.youtube.com/@creator"></textarea></label>`,
    "添加来源",
    async (form) => {
      const result = await api(`/api/channels/${channel.id}/sources`, {
        method: "POST",
        body: JSON.stringify({
          urls: form
            .get("urls")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      toast(
        `已添加 ${result.added} 条来源${result.duplicates ? `，跳过 ${result.duplicates} 条重复链接` : ""}${result.reused ? `，复用 ${result.reused} 集音频` : ""}`,
      );
    },
  );
  for (const button of $("#dialog-fields").querySelectorAll(
    "[data-delete-source]",
  )) {
    button.onclick = () => {
        const source = sources.find((s) => s.id === button.dataset.deleteSource);
      $("#dialog").close();
      confirmAction(
        "删除来源",
          `停止「${source.url}」的后续扫描，取消它的扫描任务。已发现的单集和转换任务保留，已下载音频仍可通过 RSS 收听。`,
        async () => {
          await api(
            `/api/channels/${channel.id}/sources/${button.dataset.deleteSource}`,
            { method: "DELETE" },
          );
          toast("来源已删除，已发现的单集已保留");
        },
      );
    };
  }
}
function confirmAction(title, description, handler) {
  openDialog(title, `<p>${escape(description)}</p>`, "确认", handler);
}
$("#content").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action,
    cid = button.dataset.id,
    c = data?.channels.find((c) => c.id === cid);
  try {
    if(action==='execution-resume') {await api('/api/execution-policy/resume',{method:'POST'});await refresh();toast('已恢复领取，将遵守启动间隔');return;}
    if(action==='admin-invite-create'||action==='admin-invite-edit') {
      const invite=action==='admin-invite-edit'?adminData.invites.find(i=>i.id===cid):null;
      openDialog(invite?'管理邀请码':'生成邀请码',invitationFields(invite),invite?'保存':'生成',async form=>{
        const expires=form.get('expires_at');
        const payload={label:form.get('label'),max_uses:Number(form.get('max_uses')),expires_at:expires?Math.floor(new Date(expires).getTime()/1000):null,...(invite?{enabled:form.get('enabled')==='true'}:{})};
        const result=await api(`/api/admin/invitations${invite?'/'+invite.id:''}`,{method:'POST',body:JSON.stringify(payload)});
        await loadAdmin();
        if(invite){toast('邀请码已更新');return;}
        return ()=>{
          openDialog('保存新邀请码',`<p>完整邀请码仅在本次显示，关闭后无法再次查看。请复制给需要注册的人。</p><label>邀请码<input id="new-invite-code" readonly value="${escape(result.code)}"></label><button type="button" class="small-button" id="copy-new-invite">复制邀请码</button><p class="muted">可用总次数：${payload.max_uses||'不限'}；关闭窗口不会停用此邀请码。</p>`,'',()=>{});
          $('#copy-new-invite').onclick=async()=>{try{await navigator.clipboard.writeText(result.code);toast('邀请码已复制');}catch{$('#new-invite-code').focus();$('#new-invite-code').select();toast('请手动复制已选中的邀请码');}};
        };
      });return;
    }
    if(action==='admin-invite-toggle') {
      const invite=adminData.invites.find(i=>i.id===cid);
      await api(`/api/admin/invitations/${invite.id}`,{method:'POST',body:JSON.stringify({label:invite.label,max_uses:invite.max_uses,expires_at:invite.expires_at,enabled:!invite.enabled})});
      await loadAdmin();toast(invite.enabled?'邀请码已停用':'邀请码已启用');return;
    }
    if(action==='admin-invite-prev'||action==='admin-invite-next') {await loadAdmin(adminData.offset,adminData.search,adminData.inviteOffset+(action==='admin-invite-next'?100:-100));return;}
    if(action==='admin-user') {
      const target=adminData.users.find(u=>u.id===cid);
      openDialog('管理用户',adminUserFields(target),'保存用户设置',async form=>{
        await api(`/api/admin/users/${cid}`,{method:'POST',body:JSON.stringify({role:form.get('role'),disabled:form.get('disabled')==='true',storage_limit_bytes:limitBytes(form,'storage_limit_bytes',true),monthly_transfer_limit_bytes:limitBytes(form,'monthly_transfer_limit_bytes',true)})});
        await refresh();if(data?.user.role==='admin')await loadAdmin();toast('用户设置已更新');
      });
      return;
    }
    if(action==='admin-create') {
      openDialog('新建用户','<label>用户名<input name="username" required pattern="[a-zA-Z0-9_-]{3,40}" maxlength="40"></label><label>角色<select name="role"><option value="user">普通用户</option><option value="admin">管理员</option></select></label><p>创建后生成随机密码，仅在本次显示。请通过你信任的方式交给账号使用者。</p>','创建',async form=>{
        const result=await api('/api/admin/users',{method:'POST',body:JSON.stringify({username:form.get('username'),role:form.get('role')})});await loadAdmin();
        setTimeout(()=>openDialog('保存新账号凭据',`<p>用户名：${escape(result.username)}</p><p>密码仅显示一次：</p><code>${escape(result.password)}</code>`,'',()=>{}),0);
      });return;
    }
    if(action==='admin-logout') {
      confirmAction('强制退出登录',`将退出「${adminData.users.find(u=>u.id===cid).username}」的所有网页登录会话，执行器不受影响。`,async()=>{await api(`/api/admin/users/${cid}/logout`,{method:'POST'});await refresh();if(data?.user.role==='admin')await loadAdmin();});return;
    }
    if(action==='admin-prev'||action==='admin-next'){await loadAdmin(adminData.offset+(action==='admin-next'?100:-100));return;}
    if (action === "new-channel") newChannel();
    if (action === "sources") openSources(c);
    if (action === "rss") {
      let preferred='choose';
      try {preferred=localStorage.getItem('youtast-podcast-client')||'choose';}catch{}
      if(!Object.hasOwn(podcastClients,preferred))preferred='choose';
      let links=subscriptionLinks(location.origin,c.feed_token,preferred);
      const link = links.feed;
      openDialog(
        "扫码订阅频道",
        `<p>用 iPhone / iPad 相机扫描，打开订阅页后选择播放器并确认关注。</p><label>优先打开的播放器<select id="qr-client">${Object.entries(podcastClients).map(([key,name])=>`<option value="${key}" ${key===preferred?'selected':''}>${name}</option>`).join('')}</select></label><div class="subscribe-qr"><canvas id="subscribe-qr" role="img" aria-label="${escape(c.title)} 的私人订阅二维码"></canvas><p id="qr-status" role="status">正在生成二维码…</p></div><p class="subscribe-actions"><a class="small-button" id="open-subscribe" href="${escape(links.page)}" target="_blank" rel="noopener noreferrer">打开订阅页</a><button type="button" class="small-button" id="save-subscribe-qr" disabled>保存二维码</button></p><p>也可复制 RSS 到播放器的「通过 URL 添加订阅」。</p><code>${escape(link)}</code><p><button type="button" class="small-button" id="copy-rss">复制 RSS 链接</button> <button type="button" class="small-button danger" id="rotate-rss">轮换链接</button></p><p class="muted">播放器选择记在此浏览器中，手机会预选相同选项。系统可能要求再次确认；无法由网页指定系统默认应用。二维码和链接均为私人收听凭证，轮换后旧二维码和订阅链接立即失效。</p>`,
        "",
        () => {},
      );
      const canvas=$('#subscribe-qr'),status=$('#qr-status'),save=$('#save-subscribe-qr');
      const draw=async()=>{
        links=subscriptionLinks(location.origin,c.feed_token,$('#qr-client').value);
        $('#open-subscribe').href=links.page;save.disabled=true;
        try {
          const {toCanvas}=await import('./vendor/qrcode.js');
          await toCanvas(canvas,links.page,{width:280,margin:4,errorCorrectionLevel:'M'});
          status.textContent='扫描后无需登录即可订阅此频道。';save.disabled=false;
        }catch{status.textContent='二维码生成失败，请使用订阅页或复制 RSS 链接。';}
      };
      $('#qr-client').onchange=()=>{try{localStorage.setItem('youtast-podcast-client',$('#qr-client').value);}catch{}draw();};
      save.onclick=()=>{const a=document.createElement('a');a.href=canvas.toDataURL('image/png');a.download='youtast-private-subscription.png';a.click();};
      draw();
      $("#copy-rss").onclick = async () => {
        try {
          await navigator.clipboard.writeText(link);
          toast("订阅链接已复制");
        } catch {
          toast("无法访问剪贴板，请手动选择复制");
        }
      };
      $("#rotate-rss").onclick = () => {
        $("#dialog").close();
        confirmAction(
          "轮换私人链接",
          "旧链接将失效，需要在播放器中重新订阅。",
          async () => {
            await api(`/api/channels/${cid}/rotate`, { method: "POST" });
            toast("私人链接已轮换");
          },
        );
      };
    }
    if (action === "channel-settings") openChannelSettings(c);
    if (action === "episode-details") openEpisodeDetails(data.episodes.find(e=>e.id===cid));
    if (action === "sort") {
      openDialog("频道节目排序", `<p>自动排序：来源按加入先后分组；playlist 保留列表顺序，作者视频从早到晚，单视频按加入先后。重复视频归入最早添加且已发现它的来源。下载完成先后不影响顺序。</p><label>排序方式<select name="sort_mode">${Object.entries({inherit:'跟随用户默认',...sortNames}).map(([key,label])=>`<option value="${key}" ${key===(JSON.parse(c.settings||'{}').sort_mode||'inherit')?'selected':''}>${label}</option>`).join('')}</select></label><p>缺少发布日期的历史节目暂按作者列表顺序反排；统一按发布时间排序时，缺少日期的节目排在末尾。RSS 提供串行播放提示，播放器自身的排序设置可能覆盖它。</p>`, "保存排序", async f=>{
        await api(`/api/channels/${cid}/sort`, {method:"POST",body:JSON.stringify({sort_mode:f.get("sort_mode")})});
        toast("排序已保存，播放器刷新订阅后生效");
      });
    }
    if (action === "sync") {
      await api(`/api/channels/${cid}/sync`, { method: "POST" });
      toast("已请求同步");
      await refresh();
    }
    if (action === "retry") {
      await api(`/api/jobs/${cid}/retry`, { method: "POST" });
      toast("任务已重新排队");
      await refresh();
    }
    if (action === "regenerate") {
      await api(`/api/episodes/${cid}/retry`, {method:'POST'});
      toast('已请求重新生成，存在可复用音频时将直接复用');
      await refresh();
    }
    if (action === "delete-channel")
      confirmAction(
        "删除频道",
        `将删除「${c.title}」的全部来源、任务和音频。此操作无法撤销。`,
        async () => {
          await api(`/api/channels/${cid}`, { method: "DELETE" });
          toast("频道已删除");
        },
      );
    if (action === "delete-episode")
      confirmAction(
        "删除音频",
        "音频将从存储与 RSS 移除；任务记录保留，可通过重试重新生成。",
        async () => {
          await api(`/api/episodes/${cid}`, { method: "DELETE" });
          toast("音频已删除");
        },
      );
    if (action === "revoke")
      confirmAction(
        "撤销执行器密钥",
        "该机器将无法再领取任务，进行中的租约也将失效。",
        async () => {
          await api(`/api/executors/${cid}`, { method: "DELETE" });
          toast("执行器已撤销");
        },
      );
    if (action === "new-executor")
      openDialog(
        "连接一台机器",
        '<p>为机器创建专属密钥。密钥仅显示一次，不要粘贴到公开位置。</p><label>机器名称<input name="name" required maxlength="60" placeholder="例如：家里的 Mac mini"></label>',
        "创建密钥",
        async (f) => {
          const result = await api("/api/executors", {
            method: "POST",
            body: JSON.stringify({ name: f.get("name") }),
          });
          $("#dialog").close();
          await refresh();
          setTimeout(
            () =>
              openDialog(
                "保存执行器密钥",
                `<p>密钥仅在这里显示一次，请保存到执行器机器的环境变量中。</p><code>${result.token}</code><p>配置 YOUTAST_URL 为下方地址，YOUTAST_TOKEN 为上面的密钥，再启动执行器。</p><code>${escape(location.origin)}\npython agent.py</code><p><a class="small-button" href="/install.html" target="_blank" rel="noopener">查看安装说明 ↗</a></p>`,
                "",
                () => {},
              ),
            0,
          );
        },
      );
  } catch (e) {
    toast(e.message);
  }
});
document.querySelectorAll("[data-view]").forEach(
  (b) =>
    (b.onclick = async () => {
      view = b.dataset.view;
      render();
      if(view==='admin'){try{await loadAdmin();}catch(e){toast(e.message);}}
      if(view==='executors'){try{executionData=await api('/api/execution-policy');render();}catch(e){toast(e.message);}}
    }),
);
$("#new-channel").onclick = newChannel;
$("#refresh").onclick = async()=>{await refresh();if(view==='admin'&&data?.user.role==='admin')await loadAdmin();};
$(".dialog-close").onclick = () => $("#dialog").close();
$("#auth-toggle").onclick = () => {
  register = !register;
  $("#invite-label").hidden = !register;
  $("#auth-title").textContent = register ? "创建私人账号" : "欢迎回来";
  $("#auth-subtitle").textContent = register
    ? "使用邀请码开启你的声音空间。"
    : "登录，继续你的收听旅程。";
  $("#auth-submit").textContent = register ? "创建账号 →" : "登录 →";
  $("#auth-toggle").textContent = register
    ? "已有账号？返回登录"
    : "有邀请码？创建账号";
  $("#login-form [name=password]").autocomplete = register
    ? "new-password"
    : "current-password";
  $("#auth-error").textContent = "";
};
$("#login-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  $("#auth-submit").disabled = true;
  $("#auth-error").textContent = "";
  try {
    await api(`/api/auth/${register ? "register" : "login"}`, {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    form.reset();
    await refresh();
  } catch (e) {
    $("#auth-error").textContent = e.message;
  } finally {
    $("#auth-submit").disabled = false;
  }
};
$("#logout").onclick = async () => {
  try {
    await api("/api/auth/logout", { method: "POST" });
    showAuth();
  } catch (e) {
    toast(e.message);
  }
};
document.addEventListener("visibilitychange", () => {
  if (
    !document.hidden &&
    !["settings","admin","executors"].includes(view) &&
    data &&
    ![...document.querySelectorAll("audio")].some((a) => !a.paused)
  )
    refresh();
});
setInterval(() => {
  if (
    data &&
    !["settings","admin","executors"].includes(view) &&
    !document.hidden &&
    !$("#dialog").open &&
    ![...document.querySelectorAll("audio")].some((a) => !a.paused)
  )
    refresh();
}, 60000);
await refresh();
