import {
  Empty,
  PageTitle,
  Panel,
} from './ui';

export function Requests() {
  return (
    <>
      <PageTitle
        eyebrow="WORKSPACE / REQUESTS"
        title="Requests"
        description="Browse products and create requests for items you need."
      />
      <Panel>
        <Empty title="Coming soon">
          <p className="muted">
            The product catalog and request system is under development.
            This feature will allow you to browse available products, add items to a cart,
            and submit requests for equipment and supplies.
          </p>
        </Empty>
      </Panel>
    </>
  );
}
