const taskQuery=(query,tasks)=>`${query?'?q='+encodeURIComponent(query):''}${tasks==='history'?(query?'&':'?')+'tasks=history':''}`;
export const listRoute=(kind,offset=0,query='',tasks='current')=>`#${kind}/${offset}${taskQuery(query,kind==='jobs'?tasks:'current')}`;
export const channelRoute=(id,tab,offset=0,query='',tasks='current')=>`#channel/${id}/${tab}/${offset}${taskQuery(query,tab==='jobs'?tasks:'current')}`;

export function taskViews(tasks,counts,route) {
 return `<nav class="detail-tabs" aria-label="任务分类"><a href="${route('current')}" ${tasks!=='history'?'aria-current="page"':''}>当前任务 ${counts?.jobs??0}</a><a href="${route('history')}" ${tasks==='history'?'aria-current="page"':''}>历史记录 ${counts?.history??0}</a></nav><p class="muted">${tasks==='history'?'已完成及因来源暂停、节目范围变化或音频清理而停止的记录。':`待处理 ${counts?.queued??0} · 处理中 ${counts?.running??0} · 失败 ${counts?.failed??0}`}</p>`;
}

export function searchForm(query,escape,label='搜索节目') {
 return `<form class="list-search" data-list-search role="search"><label>${label}<input name="q" type="search" maxlength="200" value="${escape(query)}" placeholder="输入关键词"></label><button class="small-button" type="submit">搜索</button>${query?'<button class="small-button" type="button" data-action="clear-search">清除</button>':''}</form>`;
}

export function pagination(page,rows,route,label='列表分页') {
 if(!page.total)return '';
 const range=rows.length?`第 ${page.offset+1}–${Math.min(page.offset+rows.length,page.total)} 条 / `:'';
 return `<nav class="detail-pagination" aria-label="${label}"><span>${range}共 ${page.total} 条</span><div>${page.offset?`<a class="small-button" href="${route(Math.max(0,page.offset-page.limit))}">上一页</a>`:''}${page.hasMore?`<a class="small-button" href="${route(page.offset+page.limit)}">下一页</a>`:''}</div></nav>`;
}

export function renderCollection(model,kind,{escape,statusNames,channels}) {
 const {page,query}=model,rows=model[kind],route=offset=>listRoute(kind,offset,query,model.tasks);
 let body;
 if(kind==='episodes')body=rows.map(e=>{
  const c=channels.find(c=>c.id===e.channel_id),token=e.feed_token||c?.feed_token,ext=e.object_key?.endsWith('.m4a')?'m4a':'mp3';
  const state=e.object_key?`${(e.size/1e6).toFixed(1)} MB`:e.expired_at?(e.cleanup_reason==='quota'?'空间不足已清理':e.cleanup_reason==='manual'?'已手动删除':'已按保留期清理'):'等待音频';
  return `<article class="list-row"><div class="list-icon">♫</div><div class="list-details"><button class="episode-title" data-action="episode-details" data-id="${e.id}">${escape(e.title)}</button><p><a href="${channelRoute(e.channel_id,'episodes')}">${escape(e.channel_title)}</a> · ${Math.floor(e.duration/60)} 分钟 · ${state}</p><div class="episode-controls"><button class="small-button" data-action="episode-details" data-id="${e.id}">简介 / 章节</button>${e.object_key?`<audio controls preload="none" data-audio-id="${e.id}" src="/media/${token}/${e.id}.${ext}"></audio><button class="small-button danger" data-action="delete-episode" data-id="${e.id}">删除音频</button>`:e.expired_at?`<button class="small-button" data-action="regenerate" data-id="${e.id}">重新生成</button>`:'<span class="badge queued">待处理</span>'}</div></div></article>`;
 }).join('');
 else body=rows.map(j=>`<article class="list-row"><div class="list-icon">${j.kind==='scan'?'⌕':'♫'}</div><div class="list-details"><strong>${escape(j.episode_title||j.channel_title)}</strong><p><a href="${channelRoute(j.channel_id,'jobs',0,'',model.tasks)}">${escape(j.channel_title)}</a> · ${j.kind==='scan'?'发现视频':'转换音频'} · ${j.reused?'已复用已有音频':`已尝试 ${j.attempts} 次`}${j.error?` · ${escape(j.error)}`:''}</p></div><span class="badge ${j.display_status||j.status}">${statusNames[j.display_status||j.status]||'已停止'}</span>${(j.display_status||j.status)==='failed'?`<button class="small-button" data-action="retry" data-id="${j.id}">重试</button>`:''}</article>`).join('');
 if(!rows.length)body=`<div class="empty" role="status">${query?'没有找到匹配的内容。':page.total?'本页暂无内容，列表可能已更新。':kind==='episodes'?'还没有单集。为频道添加来源，并运行执行器。':model.tasks==='history'?'暂无历史任务记录。':'当前没有待处理、处理中或失败的任务。'}${page.total?`<p><a class="small-button" href="${route(0)}">返回第一页</a></p>`:''}</div>`;
 else body=`<div class="list">${body}</div>`;
 return (kind==='jobs'?taskViews(model.tasks,model.counts,tasks=>listRoute(kind,0,query,tasks)):'')+searchForm(query,escape,kind==='episodes'?'搜索标题、作者或简介':'搜索节目或频道名称')+body+pagination(page,rows,route);
}
