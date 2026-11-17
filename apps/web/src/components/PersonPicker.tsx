import { useEffect, useId, useRef, useState } from 'react';
import type { AssignablePerson } from '../types';
import { Avatar, Badge, buttonClass, cx, inputClass } from './ui';

/**
 * Live people search: results appear under the box while typing; pick with a click or the
 * keyboard (↑ ↓ Enter, Esc to close). The chosen person shows as a card with "Change".
 */
export function PersonPicker({
  people,
  loading,
  search,
  onSearch,
  selected,
  onSelect,
  disabled = false,
  label = 'Assign to',
  describedBy,
}: {
  people: AssignablePerson[];
  loading: boolean;
  search: string;
  onSearch: (value: string) => void;
  selected?: AssignablePerson;
  onSelect: (person?: AssignablePerson) => void;
  disabled?: boolean;
  label?: string;
  describedBy?: string;
}) {
  const inputId = useId();
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [people]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (person: AssignablePerson) => {
    onSelect(person);
    setOpen(false);
  };
  const detail = (p: AssignablePerson) =>
    [p.designation, p.department, p.employeeCode].filter(Boolean).join(' · ') || p.email;

  if (selected)
    return (
      <div>
        <span className="mb-1.5 block text-sm font-medium text-gray-700">{label}</span>
        <div className="flex items-center gap-3 rounded-lg border border-navy-100 bg-navy-50 px-3 py-2.5">
          <Avatar userId={selected.id} name={selected.displayName} hasPhoto={selected.hasPhoto} size={40} />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="m-0 truncate font-medium text-gray-900">{selected.displayName}</p>
            <p className="m-0 mt-0.5 truncate text-xs text-gray-600">{detail(selected)}</p>
          </div>
          {selected.state === 'DIRECTORY' ? <Badge value="DIRECTORY" label="No login" /> : null}
          <button
            type="button"
            className={buttonClass('secondary', 'sm')}
            disabled={disabled}
            onClick={() => {
              onSelect(undefined);
              setOpen(true);
              window.setTimeout(() => document.getElementById(inputId)?.focus(), 0);
            }}
          >
            Change
          </button>
        </div>
      </div>
    );

  return (
    <div ref={box} className="relative">
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-gray-700">
        {label}
      </label>
      <input
        id={inputId}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-describedby={describedBy}
        aria-activedescendant={open && people[active] ? `${listId}-${active}` : undefined}
        className={inputClass}
        placeholder="Type a name, email or employee code"
        value={search}
        disabled={disabled}
        autoComplete="off"
        maxLength={100}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onSearch(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(0, people.length - 1)));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open && people[active]) {
            e.preventDefault();
            pick(people[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-30 mt-1 max-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-white p-1 shadow-lg"
        >
          {loading && !people.length ? (
            <li className="px-3 py-2.5 text-sm text-gray-500">Searching…</li>
          ) : !people.length ? (
            <li className="px-3 py-2.5 text-sm text-gray-500">
              {search.trim() ? 'No matching people' : 'Start typing to find a person'}
            </li>
          ) : (
            people.map((p, i) => (
              <li
                key={p.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cx(
                  'flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2',
                  i === active ? 'bg-navy-50' : 'hover:bg-gray-50',
                )}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(p);
                }}
              >
                <Avatar userId={p.id} name={p.displayName} hasPhoto={p.hasPhoto} size={32} />
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-sm font-medium text-gray-900">{p.displayName}</span>
                  <span className="block truncate text-xs text-gray-500">{detail(p)}</span>
                </span>
                {p.state === 'DIRECTORY' ? (
                  <span className="shrink-0 text-[11px] text-gray-400">No login</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
