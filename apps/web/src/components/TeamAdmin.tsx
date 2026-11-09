import { useParams, Link } from 'react-router-dom';
import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import { useReferences } from './References';
import {
  Badge,
  Checkbox,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
  tableWrapClass,
  buttonClass,
  noticeClass,
  tableClass,
  cx,
  formStackClass,
  inputClass,
  PersonChip,
} from './ui';

/** Super Admin page: teams (with permanent code prefixes) and room-held asset types. */
export function TeamsAndProjects() {
  const refs = useReferences();
  const action = useAction();
  const [showNew, setShowNew] = useState(false);
  const refresh = () => void refs.refetch();
  if (refs.isPending) return <Loading label="Loading teams…" />;
  if (refs.error) return <ErrorNotice error={refs.error} retry={refresh} />;
  const data = refs.data;
  const save = (path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown, version?: number) =>
    action.mutateAsync({ path, method, body, version }).then(
      () => {
        refresh();
        return true;
      },
      () => false,
    );
  const assetTypes = data.values.filter((v) => v.kind === 'ASSET_TYPE' && v.active);
  const heldByPerson = (code: string) =>
    data.assetTypePolicies?.find((p) => p.assetTypeCode === code)?.requiresCustodian !== false;
  return (
    <>
      <PageTitle
        eyebrow="Administration"
        title="Teams"
        description="Teams own assets and set their permanent asset code prefix."
      />
      <ErrorNotice error={action.error} />
      <Panel
        title="Teams"
        action={
          <button
            type="button"
            className={buttonClass(showNew ? 'secondary' : 'primary', 'sm')}
            onClick={() => setShowNew(!showNew)}
            aria-expanded={showNew}
          >
            {showNew ? 'Close' : 'Add team'}
          </button>
        }
      >
        {showNew ? (
          <div className="mb-5 rounded-lg border border-gray-200 bg-gray-50 p-4">
            <NewTeam
              onCreate={async (body) => {
                if (await save('/master-data/teams', 'POST', body)) setShowNew(false);
              }}
            />
          </div>
        ) : null}
        {(data.teams ?? []).length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Asset code prefix</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(data.teams ?? []).map((team) => (
                  <TeamRow key={team.id} team={team} save={save} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No teams yet" />
        )}
      </Panel>
      <Panel title="Ticket routing">
        <p className="mb-4 text-sm text-gray-500">
          New tickets go to the owning team of the linked asset. Otherwise they go to the team
          mapped here, or to IT when a category has no team.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.values
            .filter((v) => v.kind === 'TICKET_CATEGORY' && v.active)
            .map((category) => (
              <Select
                key={category.code}
                label={category.label}
                htmlFor={`ticket-category-team-${category.code}`}
                value={
                  data.ticketCategoryTeams?.find((m) => m.categoryCode === category.code)?.teamId ??
                  ''
                }
                onChange={(teamId) =>
                  teamId
                    ? save(
                        `/master-data/ticket-category-teams/${encodeURIComponent(category.code)}`,
                        'PUT',
                        { teamId, reason: 'Ticket routing changed in Teams' },
                      )
                    : undefined
                }
                options={[
                  { value: '', label: 'IT (default)' },
                  ...(data.teams ?? [])
                    .filter((t) => t.active)
                    .map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            ))}
        </div>
      </Panel>
      <Panel title="Asset types kept by a person">
        <p className="mb-4 text-sm text-gray-500">
          Untick types that live in a room, such as furniture or printers. Those need a location and
          may optionally be given to someone.
        </p>
        <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {assetTypes.map((type) => (
            <Checkbox
              key={type.code}
              label={`${type.label}: must be held by a person`}
              checked={heldByPerson(type.code)}
              onChange={(checked) =>
                save(
                  `/master-data/ASSET_TYPE/${encodeURIComponent(type.code)}`,
                  'PATCH',
                  { requiresCustodian: checked, reason: 'Custody rule changed in Teams' },
                  type.version,
                )
              }
            />
          ))}
        </div>
      </Panel>
    </>
  );
}

interface TeamRowData {
  id: string;
  code: string;
  name: string;
  assetCodePrefix: string;
  prefixInUse?: boolean;
  active: boolean;
  version: number;
}
type SaveFn = (
  path: string,
  method: 'POST' | 'PATCH' | 'PUT',
  body: unknown,
  version?: number,
) => Promise<boolean>;

/** One team: members link, prefix edit (only before any asset uses it) and activate/deactivate. */
function TeamRow({ team, save }: { team: TeamRowData; save: SaveFn }) {
  const [editing, setEditing] = useState(false);
  const [prefix, setPrefix] = useState(team.assetCodePrefix);
  const validPrefix = /^[A-Z]{2,5}$/.test(prefix) && prefix !== team.assetCodePrefix;
  return (
    <tr>
      <td>
        <span className="block font-medium text-gray-900">{team.name}</span>
        <span className="font-mono text-xs text-gray-500">{team.code}</span>
      </td>
      <td>
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              aria-label={`New asset code prefix for ${team.name}`}
              className={cx(inputClass, 'h-8 w-24 font-mono uppercase')}
              value={prefix}
              maxLength={5}
              autoFocus
              onChange={(event) => setPrefix(event.target.value.toUpperCase())}
            />
            <button
              type="button"
              className={buttonClass('primary', 'sm')}
              disabled={!validPrefix}
              onClick={async () => {
                const ok = await save(
                  `/master-data/teams/${team.id}`,
                  'PATCH',
                  { assetCodePrefix: prefix, reason: 'Prefix changed before first use' },
                  team.version,
                );
                if (ok) setEditing(false);
              }}
            >
              Save
            </button>
            <button
              type="button"
              className={buttonClass('ghost', 'sm')}
              onClick={() => {
                setPrefix(team.assetCodePrefix);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <>
            <span className="font-mono text-sm text-gray-900">IAC-{team.assetCodePrefix}-</span>
            <span className="block text-xs text-gray-500">
              {team.prefixInUse ? 'Locked: assets already use it' : 'Not used yet, can change'}
            </span>
          </>
        )}
      </td>
      <td>
        <Badge
          value={team.active ? 'ACTIVE' : 'Retired'}
          label={team.active ? 'Active' : 'Inactive'}
        />
      </td>
      <td>
        <div className="flex flex-nowrap items-center justify-end gap-2">
          <Link to={`/team/${team.id}`} className={buttonClass('secondary', 'sm')}>
            Members
          </Link>
          {!team.prefixInUse && !editing ? (
            <button
              type="button"
              className={buttonClass('secondary', 'sm')}
              onClick={() => setEditing(true)}
            >
              Edit prefix
            </button>
          ) : null}
          <button
            type="button"
            className={buttonClass(team.active ? 'ghost' : 'secondary', 'sm')}
            onClick={() => {
              const active = !team.active;
              if (
                !active &&
                !window.confirm(`Deactivate ${team.name}? It will no longer receive new assets.`)
              )
                return;
              void save(
                `/master-data/teams/${team.id}`,
                'PATCH',
                { active, reason: active ? 'Team reactivated' : 'Team retired' },
                team.version,
              );
            }}
          >
            {team.active ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </td>
    </tr>
  );
}

function NewTeam({ onCreate }: { onCreate: (body: unknown) => Promise<unknown> }) {
  const [form, setForm] = useState({ code: '', name: '', prefix: '', reason: '' });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const ready = form.code && form.name && /^[A-Z]{2,5}$/.test(form.prefix) && form.reason.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCreate({
      code: form.code,
      name: form.name.trim(),
      assetCodePrefix: form.prefix,
      reason: form.reason.trim(),
    });
    setForm({ code: '', name: '', prefix: '', reason: '' });
  }
  return (
    <form className={formStackClass} onSubmit={submit}>
      <Field label="New team code" htmlFor="team-code" hint="2-5 capital letters, permanent.">
        <input
          id="team-code"
          value={form.code}
          onChange={(e) => set('code', e.target.value.toUpperCase())}
          maxLength={5}
          required
        />
      </Field>
      <Field label="New team name" htmlFor="team-name">
        <input
          id="team-name"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          required
        />
      </Field>
      <Field
        label="New team asset code prefix"
        htmlFor="team-prefix"
        hint="New codes look like IAC-PREFIX-000001."
      >
        <input
          id="team-prefix"
          value={form.prefix}
          onChange={(e) => set('prefix', e.target.value.toUpperCase())}
          maxLength={5}
          required
        />
      </Field>
      <Field label="Reason for new team" htmlFor="team-reason">
        <input
          id="team-reason"
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
          required
        />
      </Field>
      <div className="form-actions">
        <button className={buttonClass()} disabled={!ready} type="submit">
          Create team
        </button>
      </div>
    </form>
  );
}

/** Team page for its Leads (and Super Admins): add, promote or remove members. */
export function TeamMembers() {
  const { teamId = '' } = useParams();
  const { user } = useSession();
  const refs = useReferences();
  const allowed = can(user, 'team.manage_members', teamId);
  const members = useQuery({
    queryKey: ['team-members', teamId],
    queryFn: ({ signal }) => api<{ items: Member[] }>(`/teams/${teamId}/members`, { signal }),
    enabled: allowed,
  });
  const action = useAction();
  const [email, setEmail] = useState('');
  const [level, setLevel] = useState('MEMBER');
  const [reason, setReason] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<
    Array<{ id: string; displayName: string; email: string }>
  >([]);
  const [showSearch, setShowSearch] = useState(false);
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You can only manage teams you lead.</p>
      </Panel>
    );
  const team = refs.data?.teams?.find((t) => t.id === teamId);
  const change = (path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown) =>
    action.mutateAsync({ path, method, body }).then(
      () => {
        setReason('');
        setEmail('');
        setSearchQuery('');
        setSearchResults([]);
        setShowSearch(false);
        void members.refetch();
      },
      () => undefined,
    );
  async function searchEmployees(q: string) {
    const trimmed = q.trim();
    if (!trimmed) {
      setSearchResults([]);
      setShowSearch(false);
      return;
    }
    try {
      const data = await api<EmployeeSearchResponse>(
        `/teams/search-employees?q=${encodeURIComponent(trimmed)}`,
      );
      setSearchResults(data.items);
      setShowSearch(data.items.length > 0);
    } catch {
      setSearchResults([]);
      setShowSearch(false);
    }
  }
  function selectEmployee(employee: { id: string; displayName: string; email: string }) {
    setEmail(employee.email);
    setSearchQuery(employee.displayName);
    setSearchResults([]);
    setShowSearch(false);
  }
  return (
    <>
      <PageTitle eyebrow="TEAM" title={team ? `${team.name} team` : 'Team members'} />
      <ErrorNotice error={action.error ?? members.error} />
      <Panel title="Change membership">
        <p className={noticeClass()} role="note">
          Saving signs that person out so the change applies straight away.
        </p>
        <div className="form-grid">
          <Field label="Reason for membership change" htmlFor="member-reason">
            <input
              id="member-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </Field>
          <Field label="Employee email" htmlFor="member-email">
            <div className="email-search-wrapper">
              <input
                id="member-email"
                type="email"
                value={searchQuery || email}
                onChange={(e) => {
                  const val = e.target.value;
                  setSearchQuery(val);
                  setEmail(val);
                  void searchEmployees(val);
                }}
                onBlur={() => {
                  setTimeout(() => setShowSearch(false), 150);
                }}
                required
              />
              {showSearch && searchResults.length > 0 ? (
                <div className="search-dropdown">
                  {searchResults.map((emp) => (
                    <button
                      key={emp.id}
                      type="button"
                      className="search-dropdown-item"
                      onClick={() => selectEmployee(emp)}
                    >
                      <span className="muted small-text">{emp.email}</span>
                      <div>{emp.displayName}</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </Field>
          <Select
            label="Level"
            htmlFor="member-level"
            value={level}
            onChange={setLevel}
            options={[
              { value: 'MEMBER', label: 'Member' },
              { value: 'LEAD', label: 'Lead' },
            ]}
            required
          />
          <div className="form-actions">
            <button
              className={buttonClass()}
              type="button"
              disabled={!email.trim() || !reason.trim() || action.isPending}
              onClick={() =>
                change(`/teams/${teamId}/members`, 'POST', {
                  email: email.trim(),
                  level,
                  reason: reason.trim(),
                })
              }
            >
              Add to team
            </button>
          </div>
        </div>
      </Panel>
      <Panel
        title={`Members${members.data?.items.length ? ` · ${members.data.items.length}` : ''}`}
      >
        {members.isPending ? (
          <Loading />
        ) : members.data?.items.length ? (
          <ul className="divide-y divide-gray-100">
            {members.data.items.map((m) => (
              <li key={m.userId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <PersonChip
                    userId={m.userId}
                    name={m.displayName}
                    hasPhoto={m.hasPhoto}
                    detail={m.designation || m.email}
                    designation={m.designation}
                    department={m.department}
                    email={m.email}
                    size={36}
                  />
                </div>
                <Badge
                  value={m.level === 'LEAD' ? 'ACTIVE' : 'OPEN'}
                  label={m.level === 'LEAD' ? 'Lead' : 'Member'}
                />
                <div className="flex flex-nowrap items-center gap-2">
                  <button
                    className={buttonClass('secondary', 'sm')}
                    type="button"
                    disabled={!reason.trim()}
                    onClick={() =>
                      change(`/teams/${teamId}/members/${m.userId}`, 'PUT', {
                        level: m.level === 'LEAD' ? 'MEMBER' : 'LEAD',
                        reason: reason.trim(),
                      })
                    }
                  >
                    {m.level === 'LEAD' ? 'Make member' : 'Make lead'}
                  </button>
                  <button
                    className={buttonClass('secondary', 'sm')}
                    type="button"
                    disabled={!reason.trim()}
                    onClick={() =>
                      change(`/teams/${teamId}/members/${m.userId}`, 'DELETE', {
                        reason: reason.trim(),
                      })
                    }
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <Empty title="No members yet" />
        )}
      </Panel>
    </>
  );
}

interface Member {
  userId: string;
  displayName: string;
  email: string;
  level: 'LEAD' | 'MEMBER';
  designation?: string | null;
  department?: string | null;
  hasPhoto?: boolean;
}

interface EmployeeSearchResponse {
  items: Array<{ id: string; displayName: string; email: string }>;
}
