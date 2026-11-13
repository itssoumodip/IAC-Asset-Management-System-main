import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, setViewAs } from '../api';
import { useSession } from '../session';
import { useReferences } from './References';
import { buttonClass, cx } from './ui';

const ROLE_CHOICES: { value: string; label: string }[] = [
  { value: 'role:FINANCE', label: 'Finance' },
  { value: 'role:EXECUTIVE', label: 'Executive' },
  { value: 'role:STORE', label: 'Store' },
  { value: 'role:TECHNICIAN', label: 'Technician' },
  { value: 'role:AUDITOR', label: 'Auditor' },
  { value: 'role:INSURER', label: 'Insurer' },
  { value: 'role:PROCUREMENT', label: 'Procurement' },
  { value: 'role:EMPLOYEE', label: 'Employee (no team)' },
];

/**
 * Switch identity and start fresh on the dashboard. A full page load guarantees that
 * the sidebar, permissions and every cached list come from the new identity.
 */
function useSwitch() {
  const client = useQueryClient();
  return async (target: string | null) => {
    setViewAs(target);
    client.clear();
    window.location.assign('/dashboard');
  };
}

/** Top-bar menu: a Super Admin picks a role or team to preview the portal as. */
export function ViewAsMenu() {
  const { user } = useSession();
  const refs = useReferences();
  const switchTo = useSwitch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!user?.roles.includes('SUPER_ADMIN') || user.viewAs) return null;
  const teams = (refs.data?.teams ?? []).filter((team) => team.active);
  async function choose(target: string) {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      // Recorded in the audit log before the preview starts.
      await api('/admin/view-as', { method: 'POST', body: { target } });
      await switchTo(target);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not start the preview');
    } finally {
      setBusy(false);
    }
  }
  return (
    <label className="hidden items-center gap-2 text-xs text-gray-500 md:flex" title={error || undefined}>
      <span className="sr-only sm:not-sr-only">View as</span>
      <select
        className={cx(
          'h-9 max-w-44 rounded-lg border bg-white px-2 text-sm text-gray-700',
          error ? 'border-red-400' : 'border-gray-200',
        )}
        value=""
        disabled={busy}
        onChange={(event) => void choose(event.target.value)}
        aria-label="Preview the portal as another role or team"
      >
        <option value="">Choose…</option>
        <optgroup label="Roles">
          {ROLE_CHOICES.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </optgroup>
        {teams.length ? (
          <optgroup label="Teams">
            {teams.flatMap((team) => [
              <option key={`${team.id}-m`} value={`team:${team.id}:MEMBER`}>
                {team.name} — member
              </option>,
              <option key={`${team.id}-l`} value={`team:${team.id}:LEAD`}>
                {team.name} — lead
              </option>,
            ])}
          </optgroup>
        ) : null}
      </select>
    </label>
  );
}

/** Shown on every page while previewing, with the way back. */
export function ViewAsBanner() {
  const { user } = useSession();
  const switchTo = useSwitch();
  if (!user?.viewAs) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-900 sm:px-6"
    >
      <span>
        Viewing the portal as <strong className="font-medium">{user.viewAs.label}</strong>. This
        is a read-only preview: nothing can be saved.
      </span>
      <button
        type="button"
        className={cx(buttonClass('secondary', 'sm'), 'ml-auto')}
        onClick={() => void switchTo(null)}
      >
        Exit preview
      </button>
    </div>
  );
}
