import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import type { CategoryResponse, Category } from '../types';
import { FormTransfer } from './DataTransfer';
import {
  Checkbox,
  Drawer,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  Select,
  tableWrapClass,
  buttonClass,
  tableClass,
  cx,
  inputClass,
} from './ui';

export function Categories() {
  const query = useQuery({
    queryKey: ['categories'],
    queryFn: ({ signal }) => api<CategoryResponse>('/admin/categories', { signal }),
  });
  const refs = useQuery({
    queryKey: ['references'],
    queryFn: ({ signal }) =>
      api<{ teams: { id: string; code: string; name: string; active: boolean }[] }>('/references', {
        signal,
      }),
  });
  const action = useAction<{
    categoryCode: string;
    handlingTeamId: string;
    owningTeamIds: string[];
  }>();
  const [editing, setEditing] = useState<Category | null>(null);
  const [handlingTeamId, setHandlingTeamId] = useState('');
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');

  const data = query.data;
  // The API returns a plain array; older responses wrapped it as { categories }.
  const categories: Category[] = Array.isArray(data)
    ? (data as Category[])
    : ((data as { categories?: Category[] } | undefined)?.categories ?? []);
  const chip = 'mr-1 mb-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700';
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

  function closeEditor() {
    setEditing(null);
    setHandlingTeamId('');
    setTeamIds([]);
    setReason('');
  }

  function teamOption(team: { id: string; code: string; name: string }) {
    return { value: team.id, label: `${team.code} · ${team.name}` };
  }

  return (
    <>
      <PageTitle
        eyebrow="Administration"
        title="Categories"
        description="Each category owns asset subcategories, is handled by a team, and can be owned by multiple teams."
      />
      <ErrorNotice error={action.error} />
      {data ? (
        <>
          <div>
            <Panel title="Categories">
              <div className={tableWrapClass}>
                <table className={cx(tableClass, 'category-table')}>
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
                    {categories.map((cat) => (
                      <tr key={cat.categoryCode}>
                        <td>
                          <span className="font-medium text-gray-900">{cat.categoryCode}</span>
                        </td>
                        <td>
                          {(cat.subcategories ?? []).map((sc) => (
                            <span key={sc.assetTypeCode} className={chip}>
                              {sc.assetTypeCode}
                            </span>
                          ))}
                        </td>
                        <td>
                          {(cat.owningTeamIds ?? []).map((tid) => {
                            const t = teams.find((team) => team.id === tid);
                            return (
                              <span key={tid} className={chip}>
                                {t ? `${t.code} · ${t.name}` : tid}
                              </span>
                            );
                          })}
                        </td>
                        <td>
                          {(() => {
                            const t = refs.data?.teams?.find(
                              (team) => team.id === cat.handlingTeamId,
                            );
                            return t ? (
                              `${t.code} · ${t.name}`
                            ) : (
                              <span className="text-gray-400">Team removed</span>
                            );
                          })()}
                        </td>
                        <td>
                          <button
                            className={buttonClass('secondary', 'sm')}
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
          <Drawer
            open={!!editing}
            title={editing ? editing.categoryCode : ''}
            description="Who handles problems with this category, and which teams may add assets to it."
            onClose={closeEditor}
            footer={
              <>
                <button type="button" className={buttonClass('secondary')} onClick={closeEditor}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={buttonClass()}
                  disabled={
                    action.isPending || !reason.trim() || !handlingTeamId || teamIds.length === 0
                  }
                  onClick={() => void save()}
                >
                  {action.isPending ? 'Saving…' : 'Save category'}
                </button>
              </>
            }
          >
            {editing ? (
              <div className="flex flex-col gap-5">
                <ErrorNotice error={action.error} />
                <Select
                  label="Handling team"
                  htmlFor="category-handling-team"
                  value={handlingTeamId}
                  onChange={setHandlingTeamId}
                  options={teams.map(teamOption)}
                  hint="Gets the support tickets raised for assets in this category."
                  required
                />
                <fieldset className="m-0 border-0 p-0">
                  <legend className="mb-1.5 text-sm font-medium text-gray-700">Owning teams</legend>
                  <div className="flex flex-col gap-2">
                    {teams.map((team) => (
                      <Checkbox
                        key={team.id}
                        label={`${team.code} · ${team.name}`}
                        checked={teamIds.includes(team.id)}
                        onChange={(checked) =>
                          setTeamIds(
                            checked
                              ? [...teamIds, team.id]
                              : teamIds.filter((id) => id !== team.id),
                          )
                        }
                      />
                    ))}
                  </div>
                  <small className="mt-1.5 block text-xs text-gray-500">
                    Teams that may add assets in this category. Choose at least one.
                  </small>
                </fieldset>
                {(editing.subcategories ?? []).length ? (
                  <div>
                    <p className="mb-1.5 text-sm font-medium text-gray-700">Subcategories</p>
                    <div>
                      {editing.subcategories.map((sc) => (
                        <span key={sc.assetTypeCode} className={chip}>
                          {sc.assetTypeCode}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <Field label="Reason for change" htmlFor="category-reason">
                  <textarea
                    id="category-reason"
                    className={cx(inputClass, 'h-auto py-2')}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    maxLength={1000}
                    rows={3}
                    placeholder="For example: Projects now buys therapy equipment"
                  />
                </Field>
                <FormTransfer
                  formId={`category-edit:${editing.categoryCode}`}
                  fields={[
                    { key: 'handlingTeamId', required: true },
                    { key: 'teamIds', type: 'list', required: true },
                    { key: 'reason', required: true },
                  ]}
                  values={{ handlingTeamId, teamIds, reason }}
                  disabled={action.isPending}
                  description="Load or save these settings as an Excel or CSV row."
                  onImport={(record) => {
                    if ('handlingTeamId' in record)
                      setHandlingTeamId(String(record.handlingTeamId ?? ''));
                    if (Array.isArray(record.teamIds)) setTeamIds(record.teamIds.map(String));
                    if ('reason' in record) setReason(String(record.reason ?? ''));
                  }}
                />
              </div>
            ) : null}
          </Drawer>
        </>
      ) : null}
    </>
  );
}
