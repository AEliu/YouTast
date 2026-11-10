export function audioChoice(episode, escape) {
 if(!episode.object_key)return '';
 return `<label class="task-choice audio-choice"><input type="checkbox" data-audio-choice value="${escape(episode.id)}" aria-label="选择音频：${escape(episode.title)}"><span>选择</span></label>`;
}

export function audioActions(episodes) {
 if(!episodes.some(e=>e.object_key))return '';
 return `<section class="task-bulk" aria-label="批量删除音频"><label class="task-choice"><input type="checkbox" data-audio-page><span>全选本页音频</span></label><span data-audio-selection-count aria-live="polite">已选 0 项</span><button class="small-button danger" data-action="audio-delete-selected" disabled>删除所选音频</button><small>仅选择当前页的音频，节目记录会保留。</small></section>`;
}

export function updateAudioSelection(root,event) {
 const choices=[...root.querySelectorAll('[data-audio-choice]')],page=root.querySelector('[data-audio-page]');
 if(event?.target===page)for(const choice of choices)choice.checked=page.checked;
 const count=choices.filter(choice=>choice.checked).length;
 if(page){page.checked=choices.length>0&&count===choices.length;page.indeterminate=count>0&&count<choices.length;page.disabled=!choices.length;}
 const label=root.querySelector('[data-audio-selection-count]');if(label)label.textContent=`已选 ${count} 项`;
 const button=root.querySelector('[data-action="audio-delete-selected"]');if(button)button.disabled=!count;
}
