import { useState, type ReactNode } from 'react';

export const assetDetailTabs = [
  { id: 'summary', label: 'Summary' },
  { id: 'details', label: 'Details' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'users', label: 'Users' },
  { id: 'history', label: 'History' },
] as const;

type AssetDetailTabId = (typeof assetDetailTabs)[number]['id'];

export function AssetDetailTabs({
  summary,
  details,
  tickets,
  users,
  history,
}: {
  summary: ReactNode;
  details: ReactNode;
  tickets: ReactNode;
  users: ReactNode;
  history: ReactNode;
}) {
  const [selected, setSelected] = useState<AssetDetailTabId>('summary');
  const content = { summary, details, tickets, users, history }[selected];
  return (
    <div className="asset-detail-tabs">
      <div className="asset-detail-tab-list" role="tablist" aria-label="Asset sections">
        {assetDetailTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected === tab.id}
            aria-controls={`asset-tabpanel-${tab.id}`}
            id={`asset-tab-${tab.id}`}
            className={`asset-detail-tab${selected === tab.id ? ' is-active' : ''}`}
            onClick={() => setSelected(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <section
        id={`asset-tabpanel-${selected}`}
        role="tabpanel"
        aria-labelledby={`asset-tab-${selected}`}
        className="asset-detail-tabpanel"
      >
        {content}
      </section>
    </div>
  );
}
