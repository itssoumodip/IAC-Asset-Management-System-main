import { describe, expect, it } from 'vitest';
import { innerLocationLevels, visibleTreeItems } from './Locations';

describe('location add-inside levels', () => {
  it('offers the first active level for a top-level location', () => {
    const levels = [
      { code: 'SITE', label: 'Site', sortOrder: 10, active: true },
      { code: 'BUILDING', label: 'Building', sortOrder: 30, active: true },
    ];
    expect(innerLocationLevels(levels, '').map((level) => level.code)).toEqual(['SITE']);
  });

  it('offers only inner levels below the selected parent', () => {
    const levels = [
      { code: 'SITE', label: 'Site', sortOrder: 10, active: true },
      { code: 'BUILDING', label: 'Building', sortOrder: 30, active: true },
      { code: 'FLOOR', label: 'Floor', sortOrder: 40, active: true },
      { code: 'RACK', label: 'Rack', sortOrder: 70, active: true },
    ];
    expect(innerLocationLevels(levels, 'BUILDING').map((level) => level.code)).toEqual([
      'FLOOR',
      'RACK',
    ]);
  });
});

describe('location tree search', () => {
  it('keeps matching locations and their ancestors in the tree', () => {
    const items = [
      { id: 'site', name: 'HQ', path: 'HQ', parentId: null },
      { id: 'building', name: 'Main', path: 'HQ / Main', parentId: 'site' },
      { id: 'floor', name: 'Third', path: 'HQ / Main / Third', parentId: 'building' },
    ] as never[];
    expect(visibleTreeItems(items, 'third').map((item) => item.id)).toEqual([
      'site',
      'building',
      'floor',
    ]);
  });
});
