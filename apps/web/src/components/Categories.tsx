import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import type { CategoryResponse, Category } from '../types';
import { FormTransfer } from './DataTransfer';
import {
  Badge,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
} from './ui';

export function Categories() {
  const query = useQuery({
    queryKey: ['categories'],
    queryFn: ({ signal }) => api<CategoryResponse>('/admin/categories', { signal }),
  });
  const refs = useQuery({
    queryKey: ['references'],
    queryFn: ({ signal }) => api<{ teams: { id: string; code: string; name: string; active: boolean }[] }>('/references', { signal }),
  });
  const action = useAction<{ categoryCode: string; handlingTeamId: string; owningTeamIds: string[] }>();
  const [editing, setEditing] = useState<Category | null>(null);
  const [handlingTeamId, setHandlingTeamId] = useState('');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');

  const data = query.data;
  const teams = refs.data?.teams?.filter((t) => t.active) ?? [];

  if (query.isPending) return <Loading label="Loading categories…" />;
  if (query.error) return <ErrorNotice error={query.error} />;

  async function save() {
    if (!editing || !reason.trim() || action.isPending) return;
    try {
      await action.mutateAsync({
        path: `/admin/categories/${encodeURIComponent(editing.categoryCode)}`,
        method: 'PUT',
        body: { handlingTeamId, teamIds, reason: reason.trim() },
      });
      setEditing(null);
      setHandlingTeamId('');
      setTeamIds([]);
      setReason('');
    } catch {
      /* error shown by ErrorNotice */
    }
  }

  function teamOption(team: { id: string; code: string; name: string }) {
    return { value: team.id, label: `${team.code} · ${team.name}` };
  }

  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRATION / CATEGORIES"
        title="Categories"
        description="Each category owns asset subcategories, is handled by a team, and can be owned by multiple teams."
      />
      <ErrorNotice error={action.error} />
      {data ? (
        <>
          <div className="dashboard-columns">
            <Panel title="Categories">
              <div className="table-scroll">
                <table className="category-table">
                  <thead>
                    <tr>
                      <th>Category</th>
                      <th>Subcategories</th>
                      <th>Owning teams</th>
                      <th>Handling team</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.categories ?? []).map((cat) => (
                      <tr key={cat.categoryCode}>
                        <td>
                          <strong>{cat.categoryCode}</strong>
                        </td>
                        <td>
                          {(cat.subcategories ?? []).map((sc) => (
                            <span key={sc.assetTypeCode} className="badge">
                              {sc.assetTypeCode}
                            </span>
                          ))}
                        </td>
                        <td>
                          {(cat.owningTeamIds ?? []).map((tid) => {
                            const t = teams.find((team) => team.id === tid);
                            return (
                              <span key={tid} className="badge">
                                {t ? `${t.code} · ${t.name}` : tid}
                              </span>
                            );
                          })}
                        </td>
                        <td>
                          <Badge value={cat.handlingTeamId} />
                        </td>
                        <td>
                          <button
                            className="button secondary small"
                            type="button"
                            onClick={() => {
                              setEditing(cat);
                              setHandlingTeamId(cat.handlingTeamId);
                              setTeamIds([...cat.owningTeamIds]);
                              setReason('');
                            }}
                          >
                            Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
          {editing ? (
            <Panel title={`Edit category · ${editing.categoryCode}`}>
              <FormTransfer
                formId={`category-edit:${editing.categoryCode}`}
                fields={[
                  { key: 'handlingTeamId', required: true },
                  { key: 'teamIds', type: 'list', required: true },
                  { key: 'reason', required: true },
                ]}
                values={{ handlingTeamId, teamIds, reason }}
                disabled={action.isPending}
                description="Change the handling team and the teams that own this category."
                onImport={(record) => {
                  if ('handlingTeamId' in record) setHandlingTeamId(String(record.handlingTeamId ?? ''));
                  if (Array.isArray(record.teamIds)) setTeamIds(record.teamIds.map(String));
                  if ('reason' in record) setReason(String(record.reason ?? ''));
                }}
              />
              <form className="form-stack" onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}>
                <ErrorNotice error={action.error} />
                <Field label="Handling team" htmlFor="category-handling-team">
                  <Select
                    label=""
                    htmlFor="category-handling-team"
                    value={handlingTeamId}
                    onChange={setHandlingTeamId}
                    options={teams.map(teamOption)}
                    required
                  />
                </Field>
                <Field
                  label="Owning teams"
                  htmlFor="category-owning-teams"
                  hint="Teams that may add assets in this category."
                >
                  <div className="team-chip-list">
                    {teams.map((team) => {
                      const selected = teamIds.includes(team.id);
                      return (
                        <label className="checkbox" key={team.id}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={(event) => {
                              if (event.target.checked) {
                                setTeamIds([...teamIds, team.id]);
                              } else {
                                setTeamIds(teamIds.filter((id) => id !== team.id));
                              }
                            }}
                          />
                          {`${team.code} · ${team.name}`}
                        </label>
                      );
                    })}
                  </div>
                </Field>
                <Field label="Reason for change" htmlFor="category-reason">
                  <textarea
                    id="category-reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    required
                    maxLength={1000}
                    rows={3}
                  />
                </Field>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button secondary"
                    disabled={action.isPending || !reason.trim()}
                    onClick={() => {
                      setEditing(null);
                      setHandlingTeamId('');
                      setTeamIds([]);
                      setReason('');
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    className="button"
                    disabled={
                      action.isPending ||
                      !reason.trim() ||
                      !handlingTeamId ||
                      teamIds.length === 0
                    }
                    onClick={save}
                  >
                    {action.isPending ? 'Saving…' : 'Save category'}
                  </button>
                </div>
              </form>
            </Panel>
          ) : null}
        </>
      ) : null}
    </>
  );
}
