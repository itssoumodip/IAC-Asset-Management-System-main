import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { ProjectReference, TeamReference } from '../types';
import { useReferences } from './References';
import { Checkbox, Empty, ErrorNotice, Field, Loading, PageTitle, Panel, Select } from './ui';

/** Super Admin page: teams (with permanent code prefixes), projects/grants and room-held asset types. */
export function TeamsAndProjects() {
  const refs = useReferences();
  const action = useAction();
  const refresh = () => void refs.refetch();
  if (refs.isPending) return <Loading />;
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
        title="Teams & projects"
        description="Teams own assets and set their code prefix. Projects and grants tag what was bought with them."
      />
      <ErrorNotice error={action.error} />
      <Panel title="Teams">
        <NewTeam onCreate={(body) => save('/master-data/teams', 'POST', body)} />
        {(data.teams ?? []).map((team) => (
          <TeamRow
            key={team.id}
            team={team}
            onSave={(body) => save(`/master-data/teams/${team.id}`, 'PATCH', body, team.version)}
          />
        ))}
      </Panel>
      <Panel title="Projects & grants">
        <NewProject onCreate={(body) => save('/master-data/projects', 'POST', body)} />
        {(data.projects ?? []).length ? (
          (data.projects ?? []).map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              onSave={(body) =>
                save(`/master-data/projects/${project.id}`, 'PATCH', body, project.version)
              }
            />
          ))
        ) : (
          <Empty title="No projects yet" />
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
                      { teamId, reason: 'Ticket routing changed in Teams & projects' },
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
                { requiresCustodian: checked, reason: 'Custody rule changed in Teams & projects' },
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
    <form className="form-grid" onSubmit={submit}>
      <Field label="New team code" htmlFor="team-code" hint="2-5 capital letters, permanent.">
        <input
          id="team-code"
          value={form.code}
          onChange={(e) => set('code', e.target.value.toUpperCase())}
          maxLength={5}
        />
      </Field>
      <Field label="New team name" htmlFor="team-name">
        <input id="team-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
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
        />
      </Field>
      <Field label="Reason for new team" htmlFor="team-reason">
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
      <button className="button" disabled={!ready}>
        Create team
      </button>
    </form>
  );
}

function TeamRow({ team, onSave }: { team: TeamReference; onSave: (body: unknown) => unknown }) {
  const [prefix, setPrefix] = useState(team.assetCodePrefix);
  return (
    <div className="form-grid" data-testid={`team-${team.code}`}>
      <strong>
        {team.name} ({team.code})
      </strong>
      <Field
        label={`Asset code prefix for ${team.code}`}
        htmlFor={`prefix-${team.id}`}
        hint={team.prefixInUse ? 'Locked: assets already use this prefix.' : undefined}
      >
        <input
          id={`prefix-${team.id}`}
          value={prefix}
          readOnly={team.prefixInUse}
          maxLength={5}
          onChange={(e) => setPrefix(e.target.value.toUpperCase())}
          onBlur={() =>
            prefix !== team.assetCodePrefix &&
            onSave({ assetCodePrefix: prefix, reason: 'Prefix changed before first use' })
          }
        />
      </Field>
      <Checkbox
        label="Active"
        checked={team.active}
        onChange={(active) =>
          onSave({ active, reason: active ? 'Team reactivated' : 'Team retired' })
        }
      />
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
    <form className="form-grid" onSubmit={submit}>
      <Field label="New project code" htmlFor="project-code">
        <input
          id="project-code"
          value={form.code}
          onChange={(e) => set('code', e.target.value)}
          maxLength={40}
        />
      </Field>
      <Field label="New project name" htmlFor="project-name">
        <input id="project-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </Field>
      <Field label="Funder" htmlFor="project-funder">
        <input
          id="project-funder"
          value={form.funder}
          onChange={(e) => set('funder', e.target.value)}
        />
      </Field>
      <Field label="Project start date" htmlFor="project-start">
        <input
          id="project-start"
          type="date"
          value={form.start}
          onChange={(e) => set('start', e.target.value)}
        />
      </Field>
      <Field label="Project end date" htmlFor="project-end">
        <input
          id="project-end"
          type="date"
          value={form.end}
          min={form.start}
          onChange={(e) => set('end', e.target.value)}
        />
      </Field>
      <Field label="Reason for new project" htmlFor="project-reason">
        <input
          id="project-reason"
          value={form.reason}
          onChange={(e) => set('reason', e.target.value)}
        />
      </Field>
      <button className="button" disabled={!ready}>
        Create project
      </button>
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
    <div className="form-grid">
      <strong>
        {project.name} ({project.code})
      </strong>
      <span className="muted">
        {project.startDate}
        {project.endDate ? ` to ${project.endDate}` : ''}
        {project.funder ? ` · ${project.funder}` : ''}
      </span>
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
        void members.refetch();
      },
      () => undefined,
    );
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
            <input id="member-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Field label="Colleague email" htmlFor="member-email">
            <input
              id="member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
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
          />
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
      </Panel>
      <Panel title="Members">
        {members.isPending ? (
          <Loading />
        ) : members.data?.items.length ? (
          members.data.items.map((m) => (
            <div key={m.userId} className="form-grid">
              <span>
                <strong>{m.displayName}</strong> <span className="muted">{m.email}</span>
              </span>
              <span>{m.level === 'LEAD' ? 'Lead' : 'Member'}</span>
              <button
                className="button secondary"
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
                className="button secondary"
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
          ))
        ) : (
          <Empty title="No members yet" />
        )}
      </Panel>
    </>
  );
}
