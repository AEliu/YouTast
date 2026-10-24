export function failedTaskChoice(job,escape) {
 if((job.display_status||job.status)!=='failed')return '';
 return `<label class="task-choice"><input type="checkbox" data-failed-job value="${escape(job.id)}" aria-label="选择失败任务：${escape(job.episode_title||job.channel_title||'发现视频')}"><span>选择</span></label>`;
}

export function taskActions(model) {
 const total=model.failedTotal??model.counts?.failed??0;
 if(model.tasks==='history'||!total)return '';
 return `<section class="task-bulk" aria-label="批量处理失败任务"><label class="task-choice"><input type="checkbox" data-failed-page><span>全选本页失败任务</span></label><span data-task-selection-count aria-live="polite">已选 0 项</span><div class="section-actions"><button class="small-button" data-action="tasks-retry-selected" disabled>重试所选</button><button class="small-button danger" data-action="tasks-dismiss-selected" disabled>清理所选</button><button class="small-button" data-action="tasks-retry-all">重试全部失败（${total}）</button><button class="small-button danger" data-action="tasks-dismiss-all">清理全部失败（${total}）</button></div><small>“全部”指${model.channel?'当前频道':'全部频道'}中与当前搜索条件匹配的失败任务，包含其他分页；节目和音频会保留。</small></section>`;
}

export function updateTaskSelection(root,event) {
 const choices=[...root.querySelectorAll('[data-failed-job]')],page=root.querySelector('[data-failed-page]');
 if(event?.target===page)for(const choice of choices)choice.checked=page.checked;
 const count=choices.filter(e=>e.checked).length;
 if(page){page.checked=choices.length>0&&count===choices.length;page.indeterminate=count>0&&count<choices.length;page.disabled=!choices.length;}
 const label=root.querySelector('[data-task-selection-count]');if(label)label.textContent=`已选 ${count} 项`;
 for(const button of root.querySelectorAll('[data-action="tasks-retry-selected"],[data-action="tasks-dismiss-selected"]'))button.disabled=!count;
}
