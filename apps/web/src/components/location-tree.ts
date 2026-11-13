// Pure location-tree helpers (from main's Locations page), kept testable on their own.

export interface LocationLevelOption {
  code: string;
  label: string;
  sortOrder: number;
  active: boolean;
}

export interface LocationTreeItem {
  id: string;
  path: string;
  parentId: string | null;
}

/** Levels a new location may use: the outermost active level at the top, else levels inside the parent. */
export function innerLocationLevels<T extends LocationLevelOption>(levels: T[], parentLevel: string) {
  if (!parentLevel) {
    const first = levels.filter((level) => level.active).sort((a, b) => a.sortOrder - b.sortOrder)[0];
    return first ? [first] : [];
  }
  const parent = levels.find((level) => level.code === parentLevel);
  return levels.filter((level) => level.active && parent && level.sortOrder > parent.sortOrder);
}

/** Search the tree but keep every ancestor of a match, so results stay in context. */
export function visibleTreeItems<T extends LocationTreeItem>(items: T[], search: string) {
  const term = search.trim().toLowerCase();
  if (!term) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const keep = new Set<string>();
  for (const item of items) {
    if (!item.path.toLowerCase().includes(term)) continue;
    let current: T | undefined = item;
    let guard = 0;
    while (current && !keep.has(current.id) && guard++ < 50) {
      keep.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return items.filter((item) => keep.has(item.id));
}
