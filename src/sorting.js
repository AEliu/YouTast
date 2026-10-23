export const SORT_MODES = ['source', 'source_grouped', 'published_asc', 'published_desc', 'added_asc', 'added_desc'];

// Automatic collection order interleaves every source; explicit choices always win.
export function effectiveSortMode(channel) {
  const mode = channel.effective_sort_mode ?? channel.sort_mode ?? 'source';
  if (mode === 'source') return Number(channel.latest_limit) > 0 ? 'published_desc' : 'source';
  return mode === 'source_grouped' ? 'source' : mode;
}

// Used after a CTE computes missing_author_dates across the visible collection.
// Every fragment is a constant; user input is never interpolated into SQL.
export function episodeOrderSql(mode) {
  const fields=['COALESCE(source_order,0)','COALESCE(added_position,source_position,0)','created_at','id'];
  const added=fields.map(f=>`${f} ${mode==='added_desc'?'DESC':'ASC'}`).join(',');
  if(mode==='added_asc'||mode==='added_desc')return added;
  if(mode==='published_asc'||mode==='published_desc')return `published_at IS NULL ASC,published_at ${mode==='published_desc'?'DESC':'ASC'},${added}`;
  return `COALESCE(source_order,0) ASC,CASE WHEN source_kind='author' THEN CASE WHEN missing_author_dates=1 THEN -COALESCE(source_position,0) ELSE published_at END ELSE COALESCE(source_position,0) END ASC,${added}`;
}

// Never use object completion time. Provenance is captured when sources are added/scanned.
export function sortEpisodes(episodes, mode = 'source') {
  const added = (a, b) => (a.source_order || 0) - (b.source_order || 0)
    || (a.added_position ?? a.source_position ?? 0) - (b.added_position ?? b.source_position ?? 0)
    || a.created_at - b.created_at || a.id.localeCompare(b.id);
  const incomplete = new Set(episodes.filter(e => e.source_kind === 'author' && !e.published_at).map(e => e.source_order));
  return [...episodes].sort((a, b) => {
    if (mode.startsWith('published_')) {
      if (!a.published_at !== !b.published_at) return a.published_at ? -1 : 1;
      return ((a.published_at || 0) - (b.published_at || 0)) * (mode === 'published_desc' ? -1 : 1) || added(a, b);
    }
    if (mode === 'added_asc' || mode === 'added_desc') return added(a, b) * (mode === 'added_desc' ? -1 : 1);
    const group = (a.source_order || 0) - (b.source_order || 0);
    if (group) return group;
    if (a.source_kind === 'author' && b.source_kind === 'author') {
      // Legacy dates may be missing: use the inverse of YouTube's newest-first tab for the whole group.
      if (!incomplete.has(a.source_order)) return a.published_at - b.published_at || added(a, b);
      return (b.source_position || 0) - (a.source_position || 0) || added(a, b);
    }
    return (a.source_position || 0) - (b.source_position || 0) || added(a, b);
  });
}
