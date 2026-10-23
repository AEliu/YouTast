export const SORT_MODES = ['source', 'published_asc', 'published_desc', 'added_asc', 'added_desc'];

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
