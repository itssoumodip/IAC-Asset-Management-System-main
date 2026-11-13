import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { buttonClass, cx } from './ui';

export interface FilterOption {
  value: string;
  label: string;
}

/** Comma-separated URL value <-> list of selected values. */
export const toList = (value: string | null | undefined) =>
  (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
export const fromList = (values: string[]) => values.join(',');

function FunnelIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={className} aria-hidden="true">
      <path d="M2.5 3.5h11l-4.25 5v3.75l-2.5 1.25v-5z" strokeLinejoin="round" />
    </svg>
  );
}

/** Checkbox list; a search box appears inside only when the list is long. */
export function CheckList({
  options,
  selected,
  onChange,
  idPrefix,
}: {
  options: FilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  idPrefix: string;
}) {
  const [term, setTerm] = useState('');
  const shown = term
    ? options.filter((o) => o.label.toLowerCase().includes(term.trim().toLowerCase()))
    : options;
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);
  return (
    <div>
      {options.length > 10 ? (
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Find…"
          aria-label="Find an option"
          className="mb-2 h-8 w-full rounded-md border border-gray-200 px-2 text-sm"
        />
      ) : null}
      <ul className="max-h-60 space-y-0.5 overflow-y-auto pr-1">
        {shown.map((o, i) => {
          const id = `${idPrefix}-${i}`;
          return (
            <li key={o.value}>
              <label htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm text-gray-700 hover:bg-gray-50">
                <input
                  id={id}
                  type="checkbox"
                  className="size-4 accent-navy-700"
                  checked={selected.includes(o.value)}
                  onChange={() => toggle(o.value)}
                />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
              </label>
            </li>
          );
        })}
        {!shown.length ? <li className="px-1.5 py-2 text-sm text-gray-400">Nothing matches</li> : null}
      </ul>
    </div>
  );
}

/** A button that opens a floating panel; closes on Escape, outside click or page scroll. */
function Popover({
  trigger,
  open,
  setOpen,
  width = 260,
  children,
}: {
  trigger: (props: { onClick: () => void; ref: Ref<HTMLButtonElement> }) => ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
  width?: number;
  children: ReactNode;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({ top: r.bottom + 6, left });
  }, [open, width]);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
      if (e instanceof MouseEvent && (panel.current?.contains(e.target as Node) || button.current?.contains(e.target as Node))) return;
      setOpen(false);
    };
    const onScroll = (e: Event) => {
      if (panel.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, setOpen]);
  return (
    <>
      {trigger({ onClick: () => setOpen(!open), ref: button })}
      {open ? (
        <div
          ref={panel}
          role="dialog"
          className="fixed z-50 max-w-[calc(100vw-16px)] rounded-lg border border-gray-200 bg-white p-3 text-left font-normal normal-case shadow-lg"
          style={{ top: pos.top, left: pos.left, width }}
        >
          {children}
        </div>
      ) : null}
    </>
  );
}

function Footer({ onClear, onApply }: { onClear: () => void; onApply: () => void }) {
  return (
    <div className="mt-3 flex justify-end gap-2 border-t border-gray-100 pt-3">
      <button type="button" className={buttonClass('ghost', 'sm')} onClick={onClear}>
        Clear
      </button>
      <button type="button" className={buttonClass('primary', 'sm')} onClick={onApply}>
        Apply
      </button>
    </div>
  );
}

/** Funnel icon for a table header; ticks several values. */
export function ColumnFilter({
  title,
  options,
  selected,
  onApply,
}: {
  title: string;
  options: FilterOption[];
  selected: string[];
  onApply: (values: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>(selected);
  useEffect(() => {
    if (open) setDraft(selected);
  }, [open]);
  const active = selected.length > 0;
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      trigger={({ onClick, ref }) => (
        <button
          ref={ref}
          type="button"
          onClick={onClick}
          aria-expanded={open}
          aria-label={active ? `Filter ${title} (${selected.length} selected)` : `Filter ${title}`}
          className={cx(
            'ml-1 inline-flex items-center gap-0.5 rounded px-1 py-0.5 align-middle',
            active ? 'bg-navy-50 text-navy-700' : 'text-gray-400 hover:text-navy-700',
          )}
        >
          <FunnelIcon className="size-3.5" />
          {active ? <span className="text-[10px] font-medium tabular-nums">{selected.length}</span> : null}
        </button>
      )}
    >
      <p className="mb-2 text-xs font-medium tracking-wide text-gray-500 uppercase">{title}</p>
      <CheckList options={options} selected={draft} onChange={setDraft} idPrefix={`cf-${title}`} />
      <Footer
        onClear={() => {
          onApply([]);
          setOpen(false);
        }}
        onApply={() => {
          onApply(draft);
          setOpen(false);
        }}
      />
    </Popover>
  );
}

export interface FilterGroup {
  key: string;
  title: string;
  options: FilterOption[];
  selected: string[];
}

/** One "Filters" button holding every filter (also the way in on phones, where headers hide). */
export function FiltersButton({
  groups,
  onApply,
}: {
  groups: FilterGroup[];
  onApply: (next: Record<string, string[]>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (open) setDraft(Object.fromEntries(groups.map((g) => [g.key, g.selected])));
  }, [open]);
  const count = groups.reduce((n, g) => n + g.selected.length, 0);
  return (
    <Popover
      open={open}
      setOpen={setOpen}
      width={Math.min(720, groups.length * 230)}
      trigger={({ onClick, ref }) => (
        <button ref={ref} type="button" onClick={onClick} aria-expanded={open} className={cx(buttonClass('secondary'), 'gap-1.5')}>
          <FunnelIcon className="size-4" />
          Filters
          {count ? (
            <span className="rounded-full bg-navy-700 px-1.5 text-[11px] leading-5 text-white tabular-nums">{count}</span>
          ) : null}
        </button>
      )}
    >
      <div className="grid max-h-[60vh] gap-4 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        {groups.map((g) => (
          <div key={g.key}>
            <p className="mb-1.5 text-xs font-medium tracking-wide text-gray-500 uppercase">{g.title}</p>
            <CheckList
              options={g.options}
              selected={draft[g.key] ?? []}
              onChange={(values) => setDraft((d) => ({ ...d, [g.key]: values }))}
              idPrefix={`fb-${g.key}`}
            />
          </div>
        ))}
      </div>
      <Footer
        onClear={() => {
          onApply(Object.fromEntries(groups.map((g) => [g.key, []])));
          setOpen(false);
        }}
        onApply={() => {
          onApply(draft);
          setOpen(false);
        }}
      />
    </Popover>
  );
}

/** Removable chips for every active filter value. */
export function FilterChips({
  groups,
  onRemove,
  onClearAll,
}: {
  groups: FilterGroup[];
  onRemove: (key: string, value: string) => void;
  onClearAll: () => void;
}) {
  const chips = groups.flatMap((g) =>
    g.selected.map((value) => ({
      key: g.key,
      value,
      // Chips show the name only, without the "(3)" count used in the lists.
      label: `${g.title}: ${(g.options.find((o) => o.value === value)?.label ?? value).replace(/ \(\d+\)$/, '')}`,
    })),
  );
  if (!chips.length) return null;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <button
          key={`${c.key}-${c.value}`}
          type="button"
          onClick={() => onRemove(c.key, c.value)}
          className="inline-flex items-center gap-1 rounded-full border border-navy-100 bg-navy-50 px-2.5 py-0.5 text-xs text-navy-800 hover:border-navy-300"
          aria-label={`Remove filter ${c.label}`}
        >
          {c.label}
          <span aria-hidden="true">✕</span>
        </button>
      ))}
      <button type="button" onClick={onClearAll} className="text-xs text-gray-500 underline-offset-2 hover:text-navy-700 hover:underline">
        Clear all
      </button>
    </div>
  );
}
