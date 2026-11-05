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
} from './ui';

/** Super Admin page: teams (with permanent code prefixes) and room-held asset types. */
export function TeamsAndProjects() {
  const refs = useReferences();
  const action = useAction();
  const refresh = () => void refs.refetch();
  if (refs.isPending) return <Loading label="Loading teams…" />;
  if (refs.error) return <ErrorNotice error={refs.error} retry={refresh} />;
  const data = refs.data;
  const save = (path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown, version?: number) =>
    action.mutateAsync({ path, method, body, version }).then(refresh, () => undefined);
  const assetTypes = data.values.filter((v) => v.kind === 'ASSET_TYPE' && v.active);
  const heldByPerson = (code: string) =>
    data.assetTypePolicies?.find((p) => p.assetTypeCode === code)?.requiresCustodian !== false;
  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / MASTER CONTROL"
        title="Teams"
        description="Teams own assets and set their permanent asset code prefix."
      />
      <ErrorNotice error={action.error} />
      <Panel title="Teams">
        <NewTeam onCreate={(body) => save('/master-data/teams', 'POST', body)} />
        {(data.teams ?? []).length ? (
          <div className="table-scroll">
            <table className="category-table">
              <thead>
                <tr>
                  <th>Team</th>
                  <th>Asset code prefix</th>
                  <th>Active</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(data.teams ?? []).map((team) => (
                  <tr key={team.id} className="team-row">
                    <td>
                      <strong>{team.name}</strong>
                      <span className="muted small-text block">· {team.code}</span>
                    </td>
                    <td>
                      <Badge value={team.assetCodePrefix} />
                      {team.prefixInUse ? (
                        <span className="muted small-text block">Locked by assets</span>
                      ) : null}
                    </td>
                    <td>
                      {team.active ? (
                        <span className="badge" style={{ background: '#e7f5e9', color: '#166534', border: '1px solid #86d496' }}>
                          Active
                        </span>
                      ) : (
                        <span className="badge" style={{ background: '#fdecea', color: '#991b1b', border: '1px solid #fca5a5' }}>
                          Inactive
                        </span>
                      )}
                    </td>
                    <td>
                      <div className="form-actions">
                        <Link
                          to={`/team/${team.id}`}
                          className="button secondary small"
                          type="button"
                        >
                          Manage members
                        </Link>
                        <button
                          className="button secondary small"
                          type="button"
                          onClick={() => {
                            // handled by inline edit below
                          }}
                          disabled={team.prefixInUse}
                        >
                          Edit prefix
                        </button>
                        <input
                          className="prefix-input"
                          value=""
                          readOnly={team.prefixInUse}
                          maxLength={5}
                          onBlur={(event) => {
                            const next = event.target.value.toUpperCase();
                            if (next && next !== team.assetCodePrefix && !team.prefixInUse) {
                              void save(
                                `/master-data/teams/${team.id}`,
                                'PATCH',
                                { assetCodePrefix: next, reason: 'Prefix changed before first use' },
                                team.version,
                              );
                            }
                          }}
                        />
                        <Checkbox
                          label={team.active ? 'Active' : 'Inactive'}
                          checked={team.active}
                          onChange={(active) =>
                            save(
                              `/master-data/teams/${team.id}`,
                              'PATCH',
                              { active, reason: active ? 'Team reactivated' : 'Team retired' },
                              team.version,
                            )
                          }
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No teams yet" />
        )}
      </Panel>
      <Panel title="Ticket categories">
        <p className="muted">
          New tickets go to the owning team of the linked asset. Otherwise they go to the team
          mapped here, or to IT when a category has no team.
        </p>
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
                ...(data.teams ?? []).filter((t) => t.active).map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          ))}
      </Panel>
      <Panel title="Asset types kept by a person">
        <p className="muted">
          Untick types that live in a room, such as furniture or printers. Those need a location and
          may optionally be given to someone.
        </p>
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
      </Panel>
    </>
  );
}

function NewTeam({ onCreate }: { onCreate: (body: unknown) => Promise<unknown> }) {
  const [form, setForm] = useState({ code: '', name: '', prefix: '', reason: '' });
  const set = (key: keyof typeof form, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));
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
    <form className="form-stack" onSubmit={submit}>
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
        <input id="team-name" value={form.name} onChange={(e) => set('name', e.target.value)} required />
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
        <button className="button" disabled={!ready} type="submit">
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
  const [searchResults, setSearchResults] = useState<Array<{ id: string; displayName: string; email: string }>>([]);
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
        <p className="notice" role="note">
          Saving signs that person out so the change applies straight away.
        </p>
        <div className="form-grid">
          <Field label="Reason for membership change" htmlFor="member-reason">
            <input id="member-reason" value={reason} onChange={(e) => setReason(e.target.value)} required />
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
              className="button"
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
      <Panel title="Members">
        {members.isPending ? (
          <Loading />
        ) : members.data?.items.length ? (
          members.data.items.map((m) => (
            <div key={m.userId} className="team-member-row">
              <span>
                <strong>{m.displayName}</strong> <span className="muted">{m.email}</span>
              </span>
              <span className="badge">{m.level === 'LEAD' ? 'Lead' : 'Member'}</span>
              <div className="form-actions">
                <button
                  className="button secondary small"
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
                  className="button secondary small"
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
            </div>
          ))
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
}

interface EmployeeSearchResponse {
  items: Array<{ id: string; displayName: string; email: string }>;
}
