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
  // New category drawer.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newHandling, setNewHandling] = useState('');
  const [newTeams, setNewTeams] = useState<string[]>([]);
  const [newReason, setNewReason] = useState('');
  const [newSubs, setNewSubs] = useState<{ name: string; requiresCustodian: boolean }[]>([]);
  const [newSubName, setNewSubName] = useState('');
  const [newSubHeld, setNewSubHeld] = useState(true);
  // New subcategory inside the edit drawer.
  const [subName, setSubName] = useState('');
  const [subHeld, setSubHeld] = useState(true);
  const sub = useAction();

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

  async function createCategory() {
    if (!newName.trim() || !newHandling || !newTeams.length || !newReason.trim() || action.isPending) return;
    try {
      await action.mutateAsync({
        path: '/admin/categories',
        method: 'POST',
        body: { name: newName.trim(), handlingTeamId: newHandling, teamIds: newTeams, reason: newReason.trim(), subcategories: newSubs },
      });
      setAdding(false);
      setNewSubs([]);
      setNewSubName('');
      setNewName('');
      setNewHandling('');
      setNewTeams([]);
      setNewReason('');
      void query.refetch();
    } catch {
      /* error shown by ErrorNotice */
    }
  }

  /** Adds a subcategory to the category being edited (uses the drawer's reason). */
  async function addSubcategory() {
    if (!editing || !subName.trim() || !reason.trim() || sub.isPending) return;
    try {
      await sub.mutateAsync({
        path: `/categories/${encodeURIComponent(editing.categoryCode)}/subcategories`,
        method: 'POST',
        body: { code: subName.trim(), label: subName.trim(), requiresCustodian: subHeld, reason: reason.trim() },
      });
      setSubName('');
      const fresh = await query.refetch();
      const list = Array.isArray(fresh.data) ? (fresh.data as Category[]) : [];
      setEditing(list.find((x) => x.categoryCode === editing.categoryCode) ?? editing);
    } catch {
      /* error shown below */
    }
  }

  /** Deletes the category being edited; the server refuses while any asset uses it. */
  async function deleteCategory() {
    if (!editing || !reason.trim() || action.isPending) return;
    if (!window.confirm(`Delete the category "${editing.categoryCode}"? Its subcategories are switched off. This works only when no asset uses it.`)) return;
    try {
      await action.mutateAsync({
        path: `/admin/categories/${encodeURIComponent(editing.categoryCode)}`,
        method: 'DELETE',
        body: { reason: reason.trim() },
      });
      closeEditor();
      void query.refetch();
    } catch {
      /* error shown by ErrorNotice */
    }
  }

  /** Removes a subcategory from use (kept in history; existing assets keep it). */
  async function removeSubcategory(code: string) {
    if (!editing || !reason.trim() || sub.isPending) return;
    if (!window.confirm(`Stop using "${code}" for new assets? Existing assets keep it.`)) return;
    try {
      await sub.mutateAsync({
        path: `/subcategories/${encodeURIComponent(code)}`,
        method: 'PATCH',
        body: { active: false, reason: reason.trim() },
      });
      const fresh = await query.refetch();
      const list = Array.isArray(fresh.data) ? (fresh.data as Category[]) : [];
      setEditing(list.find((x) => x.categoryCode === editing.categoryCode) ?? editing);
    } catch {
      /* error shown below */
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
        action={
          <button type="button" className={buttonClass()} onClick={() => setAdding(true)}>
            Add category
          </button>
        }
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
                              {sc.label ?? sc.assetTypeCode}
                            </span>
                          ))}
                          {(cat.subcategories ?? []).length ? null : <span className="text-xs text-gray-400">No subcategories yet</span>}
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
                <button
                  type="button"
                  className={cx(buttonClass('ghost'), 'mr-auto text-red-700 hover:bg-red-50 hover:text-red-800')}
                  disabled={action.isPending || !reason.trim()}
                  title={reason.trim() ? 'Delete this category' : 'Write a reason first'}
                  onClick={() => void deleteCategory()}
                >
                  Delete category
                </button>
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
                <div>
                  <p className="mb-1.5 text-sm font-medium text-gray-700">Subcategories</p>
                  <ErrorNotice error={sub.error} />
                  <ul className="mb-3 flex flex-wrap gap-1.5">
                    {(editing.subcategories ?? []).map((sc) => (
                      <li
                        key={sc.assetTypeCode}
                        className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-1 pl-2.5 text-xs text-gray-700"
                      >
                        {sc.label ?? sc.assetTypeCode}
                        {sc.assetCount ? <span className="text-gray-400">· {sc.assetCount}</span> : null}
                        <button
                          type="button"
                          className="rounded-full px-1 text-gray-400 hover:bg-gray-200 hover:text-red-700 disabled:opacity-40"
                          aria-label={`Stop using ${sc.label ?? sc.assetTypeCode}`}
                          title={reason.trim() ? 'Stop using for new assets' : 'Write a reason below first'}
                          disabled={!reason.trim() || sub.isPending}
                          onClick={() => void removeSubcategory(sc.assetTypeCode)}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                    {(editing.subcategories ?? []).length ? null : (
                      <li className="text-xs text-gray-400">No subcategories yet</li>
                    )}
                  </ul>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="min-w-48 flex-1">
                      <Field label="New subcategory" htmlFor="new-subcategory">
                        <input
                          id="new-subcategory"
                          className={inputClass}
                          value={subName}
                          onChange={(event) => setSubName(event.target.value)}
                          maxLength={100}
                          placeholder="For example: Tablet stand"
                        />
                      </Field>
                    </div>
                    <button
                      type="button"
                      className={buttonClass('secondary')}
                      disabled={!subName.trim() || !reason.trim() || sub.isPending}
                      onClick={() => void addSubcategory()}
                    >
                      {sub.isPending ? 'Adding…' : 'Add'}
                    </button>
                  </div>
                  <div className="mt-2">
                    <Checkbox label="Must be held by a person (untick for room items like furniture)" checked={subHeld} onChange={setSubHeld} />
                  </div>
                  <small className="mt-1.5 block text-xs text-gray-500">
                    Adding or removing a subcategory uses the reason written below.
                  </small>
                </div>
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
          <Drawer
            open={adding}
            title="Add category"
            description="A new group of asset types, the team that handles its problems, and the teams that may own its assets."
            onClose={() => setAdding(false)}
            footer={
              <>
                <button type="button" className={buttonClass('secondary')} onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={buttonClass()}
                  disabled={action.isPending || !newName.trim() || !newHandling || !newTeams.length || !newReason.trim()}
                  onClick={() => void createCategory()}
                >
                  {action.isPending ? 'Saving…' : 'Create category'}
                </button>
              </>
            }
          >
            <div className="flex flex-col gap-5">
              <ErrorNotice error={action.error} />
              <Field label="Category name" htmlFor="new-category-name">
                <input
                  id="new-category-name"
                  className={inputClass}
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  maxLength={100}
                  placeholder="For example: Sports Equipment"
                />
              </Field>
              <Select
                label="Handling team"
                htmlFor="new-category-handling"
                value={newHandling}
                onChange={(value) => {
                  setNewHandling(value);
                  if (value && !newTeams.includes(value)) setNewTeams([...newTeams, value]);
                }}
                options={[{ value: '', label: 'Choose a team' }, ...teams.map(teamOption)]}
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
                      checked={newTeams.includes(team.id)}
                      onChange={(checked) =>
                        setNewTeams(checked ? [...newTeams, team.id] : newTeams.filter((id) => id !== team.id))
                      }
                    />
                  ))}
                </div>
                <small className="mt-1.5 block text-xs text-gray-500">
                  Teams that may add assets in this category. Choose at least one.
                </small>
              </fieldset>
              <div>
                <p className="mb-1.5 text-sm font-medium text-gray-700">Subcategories</p>
                <ul className="mb-3 flex flex-wrap gap-1.5">
                  {newSubs.map((s) => (
                    <li
                      key={s.name}
                      className="inline-flex items-center gap-1 rounded-full bg-gray-100 py-0.5 pr-1 pl-2.5 text-xs text-gray-700"
                    >
                      {s.name}
                      {s.requiresCustodian ? null : <span className="text-gray-400">· room item</span>}
                      <button
                        type="button"
                        className="rounded-full px-1 text-gray-400 hover:bg-gray-200 hover:text-red-700"
                        aria-label={`Remove ${s.name}`}
                        onClick={() => setNewSubs(newSubs.filter((x) => x.name !== s.name))}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                  {newSubs.length ? null : <li className="text-xs text-gray-400">None yet (optional)</li>}
                </ul>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const name = newSubName.trim();
                    if (!name || newSubs.some((s) => s.name.toLowerCase() === name.toLowerCase())) return;
                    setNewSubs([...newSubs, { name, requiresCustodian: newSubHeld }]);
                    setNewSubName('');
                  }}
                >
                  <div className="min-w-48 flex-1">
                    <Field label="New subcategory" htmlFor="add-category-sub">
                      <input
                        id="add-category-sub"
                        className={inputClass}
                        value={newSubName}
                        onChange={(event) => setNewSubName(event.target.value)}
                        maxLength={100}
                        placeholder="For example: Football"
                      />
                    </Field>
                  </div>
                  <button type="submit" className={buttonClass('secondary')} disabled={!newSubName.trim()}>
                    Add
                  </button>
                </form>
                <div className="mt-2">
                  <Checkbox
                    label="Must be held by a person (untick for room items like furniture)"
                    checked={newSubHeld}
                    onChange={setNewSubHeld}
                  />
                </div>
              </div>
              <Field label="Reason" htmlFor="new-category-reason">
                <textarea
                  id="new-category-reason"
                  className={cx(inputClass, 'h-auto py-2')}
                  value={newReason}
                  onChange={(event) => setNewReason(event.target.value)}
                  maxLength={1000}
                  rows={2}
                  placeholder="For example: The sports room now has its own equipment"
                />
              </Field>
            </div>
          </Drawer>
        </>
      ) : null}    </>
  );
}
