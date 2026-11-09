import { useSession } from '../session';
import { can } from '../session';
import { Empty, PageTitle, Panel } from './ui';

/**
 * Preventive maintenance. The scheduling and completion service is not built on the API yet, so
 * this page says so plainly instead of calling an endpoint that does not exist.
 */
export function Maintenance() {
  const { user } = useSession();
  if (!can(user, 'ticket.work'))
    return (
      <Panel>
        <p role="alert">You need work order permission to view maintenance schedules.</p>
      </Panel>
    );
  return (
    <>
      <PageTitle
        eyebrow="Maintenance & audit"
        title="Preventive maintenance"
        description="Scheduled servicing for assets and subcategories."
      />
      <Panel>
        <Empty title="Maintenance scheduling is not set up yet">
          Planned servicing, due dates and completion records will appear here once scheduling is
          switched on. Until then, log repair work as a support ticket against the asset.
        </Empty>
      </Panel>
    </>
  );
}
