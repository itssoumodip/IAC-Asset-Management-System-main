import { describe, expect, it } from 'vitest';
import { assetDetailTabs } from './AssetDetailTabs';

describe('asset detail tabs', () => {
  it('keeps the agreed accessible tab names and order', () => {
    expect(assetDetailTabs.map((tab) => tab.label)).toEqual([
      'Summary',
      'Details',
      'Tickets',
      'Users',
      'History',
    ]);
  });
});
