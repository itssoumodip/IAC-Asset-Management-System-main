import { useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { ProjectReference, TeamReference } from '../types';
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

/** Super Admin page: teams (with permanent code prefixes), projects/grants and room-held asset types. */
export function TeamsAndProjects() {
  const refs = useReferences();
  const action = useAction();
  const [adding, setAdding] = useState<'team' | 'project' | null>(null);
  const refresh = () => void refs.refetch();
  if (refs.isPending) return <Loading />;
  if (refs.error) return <ErrorNotice error={refs.error} retry={refresh} />;
  const data = refs.data;
  const save = (path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown, version?: number) =>
    action.mutateAsync({ path, method, body, version }).then(refresh, () => undefined);
  const assetTypes = data.values.filter((v) => v.kind === 'ASSET_TYPE' && v.active);
  const heldByPerson = (code: string) =>
    data.assetTypePolicies?.find((p) => p.assetTypeCode === code)?.requiresCustodian !== false;
  const toggle = (kind: 'team' | 'project') => setAdding((open) => (open === kind ? null : kind));
  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / MASTER CONTROL"
        title="Teams & projects"
        description="Teams own assets and set their code prefix. Projects and grants tag what was bought with them."
      />
      <ErrorNotice error={action.error} />
      <Panel
        title="Teams"
        action={
          <button className="button secondary small" type="button" onClick={() => toggle('team')}>
            {adding === 'team' ? 'Cancel' : 'New team'}
          </button>
        }
      >
        {adding === 'team' ? (
          <NewTeam
            onCreate={(body) =>
              save('/master-data/teams', 'POST', body).then(() => setAdding(null))
            }
          />
        ) : null}
        <div className="row-list">
          {(data.teams ?? []).map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              onSave={(body) => save(`/master-data/teams/${team.id}`, 'PATCH', body, team.version)}
            />
          ))}
        </div>
      </Panel>
      <Panel
        title="Projects & grants"
        action={
          <button
            className="button secondary small"
            type="button"
            onClick={() => toggle('project')}
          >
            {adding === 'project' ? 'Cancel' : 'New project'}
          </button>
        }
      >
        {adding === 'project' ? (
          <NewProject
            onCreate={(body) =>
              save('/master-data/projects', 'POST', body).then(() => setAdding(null))
            }
          />
        ) : null}
        {(data.projects ?? []).length ? (
          <div className="row-list">
            {(data.projects ?? []).map((project) => (
              <ProjectRow
                key={project.id}
                project={project}
                onSave={(body) =>
                  save(`/master-data/projects/${project.id}`, 'PATCH', body, project.version)
                }
              />
            ))}
          </div>
        ) : (
          <Empty title="No projects yet">Add a project or grant to tag what it paid for.</Empty>
        )}
      </Panel>
      <Panel title="Ticket categories">
        <p className="muted">
          New tickets go to the owning team of the linked asset. Otherwise they go to the team
          mapped here, or to IT when a category has no team.
        </p>
        <div className="form-grid">
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
                        { teamId, reason: 'Ticket routing changed in Teams & projects' },
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
        <p className="muted">
          Untick types that live in a room, such as furniture or printers. Those need a location and
          may optionally be given to someone.
        </p>
        <div className="check-grid">
          {assetTypes.map((type) => (
            <Checkbox
              key={type.code}
              label={type.label}
              checked={heldByPerson(type.code)}
              onChange={(checked) =>
                save(
                  `/master-data/ASSET_TYPE/${encodeURIComponent(type.code)}`,
                  'PATCH',
                  {
                    requiresCustodian: checked,
                    reason: 'Custody rule changed in Teams & projects',
                  },
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

function NewTeam({ onCreate }: { onCreate: (body: unknown) => Promise<unknown> }) {
  const [form, setForm] = useState({ code: '', name: '', prefix: '', reason: '', project: false });
  const set = (key: keyof typeof form, value: string | boolean) =>
    setForm((f) => ({ ...f, [key]: value }));
  const ready = form.code && form.name && /^[A-Z]{2,5}$/.test(form.prefix) && form.reason.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCreate({
      code: form.code,
      name: form.name.trim(),
      assetCodePrefix: form.prefix,
      requiresProject: form.project,
      reason: form.reason.trim(),
    });
    setForm({ code: '', name: '', prefix: '', reason: '', project: false });
  }
  return (
    <form className="form-grid inline-create" onSubmit={submit}>
      <Field label="Team name" htmlFor="team-name">
        <input id="team-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Team code" htmlFor="team-code" hint="2-5 capital letters, permanent.">
        <input
          id="team-code"
          value={form.code}
          onChange={(e) => set('code', e.target.value.toUpperCase())}
          maxLength={5}
        />
      </Field>
      <Field
        label="Asset code prefix"
        htmlFor="team-prefix"
        hint="New codes look like IAC-PREFIX-000001."
      >
        <input
          id="team-prefix"
          value={form.prefix}
          onChange={(e) => set('prefix', e.target.value.toUpperCase())}
          maxLength={5}
        />
      </Field>
      <Field label="Why is this team needed?" htmlFor="team-reason">
        <input
          id="team-reason"
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
        />
      </Field>
      <Checkbox
        label="Assets must be tagged to a project / grant"
        checked={form.project}
        onChange={(v) => set('project', v)}
      />
      <div className="form-actions">
        <button className="button" disabled={!ready}>
          Create team
        </button>
      </div>
    </form>
  );
}

function TeamRow({ team, onSave }: { team: TeamReference; onSave: (body: unknown) => unknown }) {
  const [prefix, setPrefix] = useState(team.assetCodePrefix);
  return (
    <div className="row-item" data-testid={`team-${team.code}`}>
      <div className="row-main">
        <strong>{team.name}</strong>
        <small>
          Team code {team.code}
          {team.requiresProject ? ' · needs a project tag' : ''}
        </small>
      </div>
      <label className="row-prefix" htmlFor={`prefix-${team.id}`}>
        <span>Code prefix</span>
        <input
          id={`prefix-${team.id}`}
          value={prefix}
          readOnly={team.prefixInUse}
          title={team.prefixInUse ? 'Locked: assets already use this prefix.' : undefined}
          maxLength={5}
          onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          onBlur={() =>
            prefix !== team.assetCodePrefix &&
            onSave({ assetCodePrefix: prefix, reason: 'Prefix changed before first use' })
          }
        />
      </label>
      <Checkbox
        label="Active"
        checked={team.active}
        onChange={(active) =>
          onSave({ active, reason: active ? 'Team reactivated' : 'Team retired' })
        }
      />
      <Link to={`/team/${team.id}`} className="button secondary small">
        Manage members
      </Link>
    </div>
  );
}

function NewProject({ onCreate }: { onCreate: (body: unknown) => Promise<unknown> }) {
  const empty = { code: '', name: '', funder: '', start: '', end: '', reason: '' };
  const [form, setForm] = useState(empty);
  const set = (key: keyof typeof empty, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const ready = form.code.trim() && form.name.trim() && form.start && form.reason.trim();
  async function submit(event: FormEvent) {
    event.preventDefault();
    await onCreate({
      code: form.code.trim(),
      name: form.name.trim(),
      funder: form.funder.trim() || null,
      startDate: form.start,
      endDate: form.end || null,
      reason: form.reason.trim(),
    });
    setForm(empty);
  }
  return (
    <form className="form-grid inline-create" onSubmit={submit}>
      <Field label="Project name" htmlFor="project-name">
        <input id="project-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Project code" htmlFor="project-code">
        <input
          id="project-code"
          value={form.code}
          onChange={(e) => set('code', e.target.value)}
          maxLength={40}
        />
      </Field>
      <Field label="Funder" htmlFor="project-funder">
        <input
          id="project-funder"
          value={form.funder}
          onChange={(e) => set('funder', e.target.value)}
        />
      </Field>
      <Field label="Why is this project needed?" htmlFor="project-reason">
        <input
          id="project-reason"
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
        />
      </Field>
      <Field label="Start date" htmlFor="project-start">
        <input
          id="project-start"
          type="date"
          value={form.start}
          onChange={(e) => set('start', e.target.value)}
        />
      </Field>
      <Field label="End date (optional)" htmlFor="project-end">
        <input
          id="project-end"
          type="date"
          value={form.end}
          min={form.start}
          onChange={(e) => set('end', e.target.value)}
        />
      </Field>
      <span />
      <div className="form-actions">
        <button className="button" disabled={!ready}>
          Create project
        </button>
      </div>
    </form>
  );
}

function ProjectRow({
  project,
  onSave,
}: {
  project: ProjectReference;
  onSave: (body: unknown) => unknown;
}) {
  return (
    <div className="row-item">
      <div className="row-main">
        <strong>
          {project.name} <span className="muted">({project.code})</span>
        </strong>
        <small>
          {project.startDate}
          {project.endDate ? ` to ${project.endDate}` : ''}
          {project.funder ? ` · ${project.funder}` : ''}
        </small>
      </div>
      <Checkbox
        label="Active"
        checked={project.active}
        onChange={(active) =>
          onSave({ active, reason: active ? 'Project reopened' : 'Project closed' })
        }
      />
    </div>
  );
}

interface Member {
  userId: string;
  displayName: string;
  email: string;
  level: 'LEAD' | 'MEMBER';
}

interface Candidate {
  id: string;
  displayName: string;
  email: string;
  employeeCode: string | null;
  designation: string | null;
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
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const candidates = useQuery({
    queryKey: ['team-candidates', teamId, query],
    queryFn: ({ signal }) =>
      api<{ items: Candidate[] }>(
        `/teams/${teamId}/candidates${query ? `?q=${encodeURIComponent(query)}` : ''}`,
        { signal },
      ),
    enabled: allowed,
  });
  const action = useAction();
  const [personId, setPersonId] = useState('');
  const [level, setLevel] = useState('MEMBER');
  if (!allowed)
    return (
      <Panel>
        <p role="alert">You can only manage teams you lead.</p>
      </Panel>
    );
  const team = refs.data?.teams?.find((t) => t.id === teamId);
  const teamName = team?.name ?? 'this team';
  const people = candidates.data?.items ?? [];
  const person = people.find((p) => p.id === personId);
  const change = (path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown) =>
    action.mutateAsync({ path, method, body }).then(
      () => {
        setPersonId('');
        void members.refetch();
        void candidates.refetch();
      },
      () => undefined,
    );
  return (
    <>
      <PageTitle
        eyebrow="TEAM"
        title={team ? `${team.name} team` : 'Team members'}
        description="Members can add and look after this team's assets. Leads can also manage who is in the team."
      />
      <ErrorNotice error={action.error ?? members.error ?? candidates.error} />
      <Panel title="Add a person">
        <div className="form-grid">
          <Field label="Search people" htmlFor="member-search">
            <input
              id="member-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email or employee code"
              maxLength={100}
              autoComplete="off"
            />
          </Field>
          <Select
            label="Person"
            htmlFor="member-person"
            value={person ? personId : ''}
            onChange={setPersonId}
            disabled={candidates.isPending}
            options={[
              {
                value: '',
                label: candidates.isPending
                  ? 'Loading…'
                  : people.length
                    ? 'Choose a person'
                    : 'No one found',
              },
              ...people.map((p) => ({
                value: p.id,
                label: `${p.displayName}${p.employeeCode ? ` (${p.employeeCode})` : ''} · ${p.email}`,
              })),
            ]}
          />
          <Select
            label="Level"
            htmlFor="member-level"
            value={level}
            onChange={setLevel}
            options={[
              { value: 'MEMBER', label: 'Member: adds and looks after assets' },
              { value: 'LEAD', label: 'Lead: also manages members and retires assets' },
            ]}
          />
          <div className="form-actions">
            <button
              className="button"
              type="button"
              disabled={!person || action.isPending}
              onClick={() =>
                person &&
                change(`/teams/${teamId}/members`, 'POST', {
                  email: person.email,
                  level,
                  reason: `Added to ${teamName}`,
                })
              }
            >
              Add to team
            </button>
          </div>
        </div>
        <p className="muted">
          Only people with an active login are listed. They are signed out once so the new access
          applies straight away.
        </p>
      </Panel>
      <Panel title="Members">
        {members.isPending ? (
          <Loading />
        ) : members.data?.items.length ? (
          <div className="row-list">
            {members.data.items.map((m) => (
              <div key={m.userId} className="row-item">
                <div className="row-main">
                  <strong>{m.displayName}</strong>
                  <small>{m.email}</small>
                </div>
                <Badge value={m.level} label={m.level === 'LEAD' ? 'Lead' : 'Member'} />
                <button
                  className="button secondary small"
                  type="button"
                  disabled={action.isPending}
                  onClick={() =>
                    change(`/teams/${teamId}/members/${m.userId}`, 'PUT', {
                      level: m.level === 'LEAD' ? 'MEMBER' : 'LEAD',
                      reason: m.level === 'LEAD' ? 'Changed to member' : 'Made lead',
                    })
                  }
                >
                  {m.level === 'LEAD' ? 'Make member' : 'Make lead'}
                </button>
                <button
                  className="button secondary small"
                  type="button"
                  disabled={action.isPending}
                  onClick={() =>
                    window.confirm(`Remove ${m.displayName} from ${teamName}?`) &&
                    change(`/teams/${teamId}/members/${m.userId}`, 'DELETE', {
                      reason: `Removed from ${teamName}`,
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No members yet">Search for a person above and add them.</Empty>
        )}
      </Panel>
    </>
  );
}
