import {requireValue} from './lib.js';

// Legacy jobs use 'failed' for these intentional stops. Keep their records and
// scheduling semantics, but do not present them as errors needing attention.
const stoppedReasons=[
 '不在最新节目范围，暂不转换',
 '来源已暂停',
 '音频已由用户删除',
 '音频保留期已到，已自动清理',
 '空间不足，旧音频已自动清理',
];
export function taskView(url) {
 const view=url.searchParams.get('tasks')||'current';
 requireValue(['current','history'].includes(view),400,'任务分类无效');
 return view;
}
export function taskStateSql(alias='j') {
 const reasons=stoppedReasons.map(s=>"'"+s.replaceAll("'","''")+"'").join(',');
 return `CASE WHEN ${alias}.dismissed_at IS NOT NULL THEN 'dismissed' WHEN ${alias}.status='failed' AND ${alias}.error IN(${reasons}) THEN 'stopped' ELSE ${alias}.status END`;
}
export function taskCondition(view,alias='j') {
 const state=taskStateSql(alias);
 return `${state} IN(${view==='history'?"'done','stopped'":"'queued','running','failed'"})`;
}
export function taskCountsSql(alias='j') {
 return `COALESCE(SUM(${taskCondition('current',alias)}),0) jobs,
  COALESCE(SUM(${taskCondition('history',alias)}),0) history,
  COALESCE(SUM(${alias}.status='queued'),0) queued,
  COALESCE(SUM(${alias}.status='running'),0) running,
  COALESCE(SUM(${taskStateSql(alias)}='failed'),0) failed,
  COALESCE(SUM(${alias}.status IN('queued','running')),0) active`;
}
