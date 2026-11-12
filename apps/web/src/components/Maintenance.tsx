import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { AssignablePerson } from '../types';
import { StatTile } from './charts';
import { useReferences } from './References';
import {
  Drawer,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  PersonChip,
  Select,
  buttonClass,
  cx,
  displayDate,
  inputClass,
  tableClass,
  tableWrapClass,
} from './ui';

interface Schedule {
  id: string;
  title: string;
  intervalDays: number;
  nextDue: string;
  assetId: string;
  assetCode: string;
  assetDescription: string;
  assetType: string | null;
  teamCode: string | null;
  assignedTo: string | null;
  assignedName: string | null;
  assignedEmail: string | null;
  assignedHasPhoto: boolean;
  daysUntilDue: number;
  lastDone: string | null;
}
interface MaintenanceResponse {
  items: Schedule[];
  summary: { overdue: number; dueThisWeek: number; active: number; doneThisMonth: number };
}
type View = 'upcoming' | 'overdue' | 'all';
const views: { key: View; label: string }[] = [
  { key: 'upcoming', label: 'Due in 30 days' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'all', label: 'All schedules' },
];
const intervals = [
  { value: '30', label: 'Every month' },
  { value: '90', label: 'Every 3 months' },
  { value: '180', label: 'Every 6 months' },
  { value: '365', label: 'Every year' },
  { value: 'custom', label: 'Custom number of days' },
];
const everyLabel = (days: number) =>
  ({ 30: 'Monthly', 90: 'Every 3 months', 180: 'Every 6 months', 365: 'Yearly' })[days] ??
  `Every ${days} days`;
const todayIso = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

function DueCell({ s }: { s: Schedule }) {
  const tone =
    s.daysUntilDue < 0
      ? 'text-red-700 font-medium'
      : s.daysUntilDue <= 7
        ? 'text-yellow-800 font-medium'
        : 'text-gray-700';
  const hint =
    s.daysUntilDue < 0
      ? `${-s.daysUntilDue} day${s.daysUntilDue === -1 ? '' : 's'} overdue`
      : s.daysUntilDue === 0
        ? 'Due today'
        : `In ${s.daysUntilDue} day${s.daysUntilDue === 1 ? '' : 's'}`;
  return (
    <>
      <span className={cx('block', tone)}>{displayDate(s.nextDue)}</span>
      <span className="text-xs text-gray-500">{hint}</span>
    </>
  );
}

function NewSchedule({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const refs = useReferences();
  const action = useAction<{ created: number }>();
  const [target, setTarget] = useState<'asset' | 'type'>('asset');
  const [assetCode, setAssetCode] = useState('');
  const [assetType, setAssetType] = useState('');
  const [title, setTitle] = useState('');
  const [interval, setInterval] = useState('90');
  const [customDays, setCustomDays] = useState('');
  const [firstDue, setFirstDue] = useState(todayIso());
  const [assignee, setAssignee] = useState('');
  const [peopleSearch, setPeopleSearch] = useState('');
  const [peopleQ, setPeopleQ] = useState('');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setPeopleQ(peopleSearch.trim()), 250);
    return () => clearTimeout(timer);
  }, [peopleSearch]);
  const people = useQuery({
    queryKey: ['maintenance-people', peopleQ],
    queryFn: ({ signal }) =>
      api<{ items: AssignablePerson[] }>(
        `/assignable-people?limit=25${peopleQ ? `&q=${encodeURIComponent(peopleQ)}` : ''}`,
        { signal },
      ),
    placeholderData: (previous) => previous,
    retry: false,
  });
  const days = interval === 'custom' ? Number(customDays) : Number(interval);
  const ready =
    title.trim() &&
    reason.trim() &&
    firstDue &&
    Number.isInteger(days) &&
    days >= 1 &&
    days <= 3650 &&
    (target === 'asset' ? assetCode.trim() : assetType);

  async function submit() {
    if (!ready || action.isPending) return;
    const result = await action
      .mutateAsync({
        path: '/maintenance/schedules',
        method: 'POST',
        body: {
          ...(target === 'asset' ? { assetCode: assetCode.trim().toUpperCase() } : { assetType }),
          title: title.trim(),
          intervalDays: days,
          firstDue,
          assignedTo: assignee || null,
          reason: reason.trim(),
        },
      })
      .catch(() => undefined);
    if (result) {
      setMessage(
        result.created === 1
          ? 'Schedule created.'
          : `${result.created} schedules created, one per asset.`,
      );
      onCreated();
    }
  }

  const assetTypes = (refs.data?.values ?? []).filter(
    (v) => v.kind.toUpperCase() === 'ASSET_TYPE' && v.active,
  );
  return (
    <Drawer
      open
      title="New maintenance schedule"
      description="A repeating service task. Each completion moves the next due date forward."
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass('secondary')} onClick={onClose}>
            {message ? 'Close' : 'Cancel'}
          </button>
          <button
            type="button"
            className={buttonClass()}
            disabled={!ready || action.isPending}
            onClick={() => void submit()}
          >
            {action.isPending ? 'Saving…' : 'Create schedule'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorNotice error={action.error} />
        {message ? (
          <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-800" role="status">
            {message}
          </p>
        ) : null}
        <fieldset className="m-0 border-0 p-0">
          <legend className="mb-1.5 text-sm font-medium text-gray-700">Applies to</legend>
          <div className="flex gap-2">
            {(
              [
                ['asset', 'One asset'],
                ['type', 'Every asset in a subcategory'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                aria-pressed={target === key}
                onClick={() => setTarget(key)}
                className={buttonClass(target === key ? 'primary' : 'secondary', 'sm')}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
        {target === 'asset' ? (
          <Field label="Asset code" htmlFor="mnt-asset" hint="For example IAC-IT-000012">
            <input
              id="mnt-asset"
              className={cx(inputClass, 'font-mono uppercase')}
              value={assetCode}
              onChange={(e) => setAssetCode(e.target.value)}
              maxLength={40}
            />
          </Field>
        ) : (
          <Select
            label="Subcategory"
            htmlFor="mnt-type"
            value={assetType}
            onChange={setAssetType}
            hint="A schedule is created for each asset of this type that is still in service."
            options={[
              { value: '', label: 'Choose a subcategory' },
              ...assetTypes.map((v) => ({ value: v.code, label: v.label })),
            ]}
          />
        )}
        <Field
          label="Task"
          htmlFor="mnt-title"
          hint="For example: AC filter cleaning, UPS battery check"
        >
          <input
            id="mnt-title"
            className={inputClass}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="How often"
            htmlFor="mnt-interval"
            value={interval}
            onChange={setInterval}
            options={intervals}
          />
          <Field label="First due" htmlFor="mnt-first">
            <input
              id="mnt-first"
              type="date"
              className={inputClass}
              value={firstDue}
              onChange={(e) => setFirstDue(e.target.value)}
            />
          </Field>
        </div>
        {interval === 'custom' ? (
          <Field label="Repeat every (days)" htmlFor="mnt-days">
            <input
              id="mnt-days"
              type="number"
              min={1}
              max={3650}
              className={cx(inputClass, 'w-32')}
              value={customDays}
              onChange={(e) => setCustomDays(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="flex flex-col gap-2">
          <Field label="Assigned to (optional)" htmlFor="mnt-person-search">
            <input
              id="mnt-person-search"
              type="search"
              className={inputClass}
              value={peopleSearch}
              onChange={(e) => setPeopleSearch(e.target.value)}
              placeholder="Search name or email"
              autoComplete="off"
            />
          </Field>
          <Select
            label=""
            htmlFor="mnt-person"
            value={assignee}
            onChange={setAssignee}
            options={[
              { value: '', label: 'Nobody yet' },
              ...(people.data?.items ?? []).map((p) => ({
                value: p.id,
                label: `${p.displayName} · ${p.email}`,
              })),
            ]}
          />
        </div>
        <Field label="Reason" htmlFor="mnt-reason">
          <input
            id="mnt-reason"
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            placeholder="For example: manufacturer service interval"
          />
        </Field>
      </div>
    </Drawer>
  );
}

function CompleteDrawer({
  schedule,
  onClose,
  onDone,
}: {
  schedule: Schedule;
  onClose: () => void;
  onDone: () => void;
}) {
  const action = useAction<{ nextDue: string }>();
  const [notes, setNotes] = useState('');
  const history = useQuery({
    queryKey: ['maintenance-history', schedule.id],
    queryFn: ({ signal }) =>
      api<{
        items: {
          id: string;
          dueDate: string;
          completedAt: string;
          notes: string | null;
          completedByName: string | null;
        }[];
      }>(`/maintenance/schedules/${schedule.id}/history`, { signal }),
  });
  async function done() {
    const result = await action
      .mutateAsync({
        path: `/maintenance/schedules/${schedule.id}/complete`,
        method: 'POST',
        body: { notes: notes.trim() || null },
      })
      .catch(() => undefined);
    if (result) onDone();
  }
  return (
    <Drawer
      open
      title={schedule.title}
      description={`${schedule.assetCode} · ${schedule.assetDescription}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={buttonClass('secondary')} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={buttonClass()}
            disabled={action.isPending}
            onClick={() => void done()}
          >
            {action.isPending ? 'Saving…' : 'Mark as done today'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <ErrorNotice error={action.error} />
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-xs text-gray-500">Due</dt>
            <dd className="mt-0.5">
              <DueCell s={schedule} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Repeats</dt>
            <dd className="mt-0.5 text-gray-800">{everyLabel(schedule.intervalDays)}</dd>
          </div>
        </dl>
        <Field label="What was done (optional)" htmlFor="mnt-notes">
          <textarea
            id="mnt-notes"
            className={cx(inputClass, 'h-auto py-2')}
            rows={4}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Parts replaced, readings, anything the next person should know"
          />
        </Field>
        <section>
          <h3 className="mb-2 text-sm font-medium text-gray-700">Service history</h3>
          {history.isPending ? (
            <Loading />
          ) : history.data?.items.length ? (
            <ol className="flex flex-col gap-3 border-l border-gray-200 pl-4">
              {history.data.items.map((r) => (
                <li key={r.id} className="text-sm">
                  <span className="font-medium text-gray-900">{displayDate(r.completedAt)}</span>
                  <span className="text-gray-500"> · {r.completedByName ?? 'Unknown'}</span>
                  {r.notes ? (
                    <p className="mt-0.5 whitespace-pre-wrap text-gray-600">{r.notes}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-gray-500">Not serviced yet.</p>
          )}
        </section>
      </div>
    </Drawer>
  );
}

/** Preventive maintenance: repeating service tasks, what is due, and completion records. */
export function Maintenance() {
  const { user } = useSession();
  const [view, setView] = useState<View>('upcoming');
  const [creating, setCreating] = useState(false);
  const [completing, setCompleting] = useState<Schedule | null>(null);
  const stop = useAction();
  const query = useQuery({
    queryKey: ['maintenance', view],
    queryFn: ({ signal }) => api<MaintenanceResponse>(`/maintenance?view=${view}`, { signal }),
    enabled: can(user, 'ticket.work'),
    placeholderData: (previous) => previous,
  });
  if (!can(user, 'ticket.work'))
    return (
      <Panel>
        <p role="alert">You need work order permission to view maintenance schedules.</p>
      </Panel>
    );
  const summary = query.data?.summary;
  const items = query.data?.items ?? [];
  const refresh = () => void query.refetch();

  return (
    <>
      <PageTitle
        eyebrow="Maintenance & audit"
        title="Preventive maintenance"
        description="Repeating service tasks for assets, what is due next, and who did the work."
        action={
          <button type="button" className={buttonClass()} onClick={() => setCreating(true)}>
            New schedule
          </button>
        }
      />
      <ErrorNotice error={query.error ?? stop.error} retry={refresh} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Overdue" value={summary?.overdue ?? '—'} detail="Past their due date" />
        <StatTile label="Due this week" value={summary?.dueThisWeek ?? '—'} detail="Next 7 days" />
        <StatTile
          label="Active schedules"
          value={summary?.active ?? '—'}
          detail="Repeating tasks"
        />
        <StatTile
          label="Done this month"
          value={summary?.doneThisMonth ?? '—'}
          detail="Completed services"
        />
      </div>
      <Panel>
        <div className="mb-4 flex flex-wrap gap-2" role="tablist">
          {views.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              className={buttonClass(view === v.key ? 'primary' : 'secondary', 'sm')}
              onClick={() => setView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {query.isPending ? (
          <Loading label="Loading maintenance…" />
        ) : items.length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th>Task</th>
                  <th>Repeats</th>
                  <th>Next due</th>
                  <th>Assigned to</th>
                  <th>Last done</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link
                        to={`/assets/${s.assetId}`}
                        className="font-medium text-navy-700 no-underline hover:underline"
                      >
                        {s.assetCode}
                      </Link>
                      <span className="block max-w-56 truncate text-xs text-gray-500">
                        {s.assetDescription}
                      </span>
                    </td>
                    <td className="text-gray-900">{s.title}</td>
                    <td>{everyLabel(s.intervalDays)}</td>
                    <td>
                      <DueCell s={s} />
                    </td>
                    <td>
                      {s.assignedTo && s.assignedName ? (
                        <PersonChip
                          userId={s.assignedTo}
                          name={s.assignedName}
                          hasPhoto={s.assignedHasPhoto}
                          email={s.assignedEmail}
                        />
                      ) : (
                        <span className="text-gray-400">Not assigned</span>
                      )}
                    </td>
                    <td className="text-gray-500">
                      {s.lastDone ? displayDate(s.lastDone) : 'Never'}
                    </td>
                    <td>
                      <div className="flex flex-nowrap items-center justify-end gap-2">
                        <button
                          type="button"
                          className={buttonClass('secondary', 'sm')}
                          onClick={() => setCompleting(s)}
                        >
                          Mark done
                        </button>
                        <button
                          type="button"
                          className={buttonClass('ghost', 'sm')}
                          disabled={stop.isPending}
                          onClick={() => {
                            const reason = window.prompt(
                              `Stop "${s.title}" for ${s.assetCode}? Give a reason:`,
                            );
                            if (!reason?.trim()) return;
                            void stop
                              .mutateAsync({
                                path: `/maintenance/schedules/${s.id}/stop`,
                                method: 'POST',
                                body: { reason: reason.trim() },
                              })
                              .then(refresh, () => undefined);
                          }}
                        >
                          Stop
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={
              view === 'overdue'
                ? 'Nothing overdue'
                : view === 'upcoming'
                  ? 'Nothing due in the next 30 days'
                  : 'No maintenance schedules yet'
            }
            action={
              view === 'all' ? (
                <button type="button" className={buttonClass()} onClick={() => setCreating(true)}>
                  New schedule
                </button>
              ) : undefined
            }
          >
            {view === 'all'
              ? 'Create a schedule for an asset, or for every asset in a subcategory.'
              : 'Switch to All schedules to see every repeating task.'}
          </Empty>
        )}
      </Panel>
      {creating ? <NewSchedule onClose={() => setCreating(false)} onCreated={refresh} /> : null}
      {completing ? (
        <CompleteDrawer
          schedule={completing}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setCompleting(null);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}
