import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';

/** Joins class names, skipping empty values. */
export function cx(...names: (string | false | null | undefined)[]) {
  return names.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';
const buttonBase =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-navy-500 disabled:cursor-not-allowed disabled:opacity-55';
const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'border border-navy-700 bg-navy-700 text-white hover:border-navy-800 hover:bg-navy-800 active:bg-navy-900',
  secondary:
    'border border-gray-300 bg-white text-gray-800 hover:border-navy-200 hover:bg-navy-50 hover:text-navy-700',
  ghost:
    'border border-transparent bg-transparent text-gray-600 hover:bg-gray-100 hover:text-navy-800',
  danger: 'border border-red-600 bg-red-600 text-white hover:border-red-700 hover:bg-red-700',
};
const buttonSizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
};
/** Tailwind classes for a brand button; use on <button>, <a> or <Link>. */
export function buttonClass(variant: ButtonVariant = 'primary', size: ButtonSize = 'md') {
  return cx(buttonBase, buttonVariants[variant], buttonSizes[size]);
}
/* Shared Tailwind class sets for markup used across pages. */
/** Text link inside tables and lists. */
export const linkClass =
  'whitespace-nowrap text-sm font-medium text-navy-700 no-underline hover:text-navy-900 hover:underline';
/** A row of buttons or links. */
export const actionsClass = 'flex flex-wrap items-center gap-2';
/** Back link above a page title. */
export const backLinkClass =
  'mb-3 inline-flex items-center gap-1 text-sm font-medium text-gray-500 no-underline hover:text-navy-700';
/** Small uppercase label above a value. */
export const metaLabelClass =
  'mb-1 block text-[11px] font-semibold tracking-wide text-gray-500 uppercase';
/** Filter controls above a list: equal-width fields that wrap. */
export const filterBarClass =
  'mb-5 flex flex-wrap items-end gap-3 [&>*]:min-w-36 [&>*]:flex-1 [&>form]:min-w-64 [&>form]:flex-[2]';
/** Search input + button pair inside a filter bar. */
export const searchFormClass = 'flex items-center gap-2 [&>input]:min-w-0 [&>input]:flex-1';
/** Scroll wrapper for a data table. */
export const tableWrapClass = 'max-w-full overflow-x-auto';
/** Styles a whole data table (header, cells, rows) from the <table> element. */
export const tableClass = cx(
  'w-full min-w-0 border-collapse text-left text-sm',
  '[&_th]:border-b [&_th]:border-gray-200 [&_th]:bg-gray-50 [&_th]:px-3 [&_th]:py-2.5 [&_th]:text-xs [&_th]:font-medium [&_th]:tracking-normal [&_th]:whitespace-nowrap [&_th]:text-gray-500 [&_th]:normal-case',
  '[&_td]:border-b [&_td]:border-gray-100 [&_td]:px-3 [&_td]:py-3 [&_td]:min-w-24 [&_td]:align-middle [&_td]:text-gray-700 [&_td:first-child]:max-w-none [&_td:first-child]:whitespace-nowrap',
  '[&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-gray-50/70',
);
type NoticeTone = 'info' | 'success' | 'warning' | 'danger';
const noticeTones: Record<NoticeTone, string> = {
  info: 'border-navy-100 border-l-navy-500 bg-navy-50 text-navy-900',
  success: 'border-sky-100 border-l-sky-600 bg-sky-50 text-sky-900',
  warning: 'border-yellow-100 border-l-yellow-500 bg-yellow-50 text-yellow-900',
  danger: 'border-red-100 border-l-red-600 bg-red-50 text-red-900',
};
/** Inline message box. */
export function noticeClass(tone: NoticeTone = 'info') {
  return cx(
    'mb-4 rounded-lg border border-l-4 px-4 py-3 text-sm leading-relaxed [&_strong]:block [&_strong]:font-semibold [&_p]:mt-0.5',
    noticeTones[tone],
  );
}
/**
 * Form layout: fields flow into two columns when there is room (one in narrow panels).
 * Anything that is not a Field (notes, checkboxes, buttons) spans the full width.
 */
export const formStackClass =
  'grid grid-cols-[repeat(auto-fill,minmax(max(16rem,calc(50%-0.5rem)),1fr))] items-start gap-x-4 gap-y-4 [&>:not(.field)]:col-span-full [&>button]:justify-self-start';
/** File picker: a small brand button plus the chosen file name. */
export const fileInputClass =
  'block w-full cursor-pointer rounded-lg border border-dashed border-gray-300 bg-white p-1.5 text-sm text-gray-600 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-navy-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-navy-700 hover:file:bg-navy-100 disabled:cursor-not-allowed disabled:opacity-60';
/** Text inputs, selects and textareas. */
export const inputClass =
  'h-10 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-800 placeholder:text-gray-400 focus:border-navy-500 focus:ring-2 focus:ring-navy-100 focus:outline-none disabled:bg-gray-50 disabled:text-gray-400';

/**
 * Side panel for editing one record without leaving the list: slides in from the right,
 * closes on Escape, the close button or a click on the dimmed page.
 */
export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: PropsWithChildren<{
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  footer?: ReactNode;
}>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        aria-label="Close panel"
        className="absolute inset-0 bg-navy-950/30"
        onClick={onClose}
      />
      <aside className="relative flex h-full w-full max-w-lg flex-col bg-white shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-gray-200 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-navy-900">{title}</h2>
            {description ? <p className="mt-0.5 text-sm text-gray-500">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-navy-800"
          >
            <svg
              viewBox="0 0 20 20"
              className="size-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="m5 5 10 10M15 5 5 15" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer ? (
          <footer className="flex justify-end gap-2 border-t border-gray-200 px-6 py-4">
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  );
}

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={cx(buttonClass(variant, size), className)} {...props} />;
}

export function PageTitle({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-red-600">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight text-navy-900">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-500">{description}</p>
        ) : null}
      </div>
      {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
    </header>
  );
}
export function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  if (!error) return null;
  const message =
    error instanceof Error ? error.message : 'Something went wrong. Please try again.';
  return (
    <div
      className="mb-4 rounded-lg border border-red-100 border-l-4 border-l-red-600 bg-red-50 px-4 py-3 text-sm text-red-900"
      role="alert"
    >
      <strong className="font-semibold">Action needed</strong>
      <p className="mt-0.5">{message}</p>
      {error instanceof ApiError && error.fields ? (
        <ul className="mt-1 list-disc pl-5">
          {Object.entries(error.fields).map(([name, text]) => (
            <li key={name}>
              {name}: {text}
            </li>
          ))}
        </ul>
      ) : null}
      {error instanceof ApiError && error.requestId ? (
        <small className="mt-1 block text-xs text-red-700">Reference: {error.requestId}</small>
      ) : null}
      {retry ? (
        <button
          type="button"
          className={cx(buttonClass('secondary', 'sm'), 'mt-3')}
          onClick={retry}
        >
          Reload data
        </button>
      ) : null}
    </div>
  );
}
export function Loading({ label = 'Loading…' }: { label?: string }) {
  const [visible, setVisible] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 180);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div
      className={cx(
        'flex min-h-[40vh] flex-col items-center justify-center gap-3 text-sm text-gray-500 transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      aria-hidden={!visible}
    >
      {visible ? (
        <>
          <span
            className="grid size-12 place-items-center rounded-xl bg-white ring-1 ring-gray-200 motion-safe:animate-pulse"
            aria-hidden="true"
          >
            {logoFailed ? (
              <span className="size-3 rounded-full bg-navy-700" />
            ) : (
              <img
                src="/loading-logo.png"
                alt=""
                className="size-8"
                onError={() => setLogoFailed(true)}
              />
            )}
          </span>
          <span role="status" aria-live="polite">
            {label}
          </span>
        </>
      ) : null}
    </div>
  );
}
export function Empty({
  title,
  children,
  action,
}: PropsWithChildren<{ title: string; action?: ReactNode }>) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 bg-white px-6 py-10 text-center">
      <h3 className="text-base font-semibold text-navy-900">{title}</h3>
      <div className="mx-auto mt-1 max-w-md text-sm text-gray-500">{children}</div>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}

type Tone = 'success' | 'danger' | 'warning' | 'info' | 'neutral';
const toneClasses: Record<Tone, { pill: string; dot: string }> = {
  success: { pill: 'bg-sky-50 text-sky-800 ring-sky-100', dot: 'bg-sky-500' },
  danger: { pill: 'bg-red-50 text-red-700 ring-red-100', dot: 'bg-red-600' },
  warning: { pill: 'bg-yellow-50 text-yellow-800 ring-yellow-100', dot: 'bg-yellow-500' },
  info: { pill: 'bg-navy-50 text-navy-700 ring-navy-100', dot: 'bg-navy-500' },
  neutral: { pill: 'bg-gray-100 text-gray-600 ring-gray-200', dot: 'bg-gray-400' },
};
export function badgeTone(value: string | undefined | null): Tone {
  if (!value) return 'neutral';
  if (
    [
      'COMPLETED',
      'ACCEPTED',
      'ACTIVE',
      'Active',
      'Assigned',
      'In Use',
      'APPROVED',
      'Good',
      'New',
      'In Stock',
    ].includes(value)
  )
    return 'success';
  if (
    [
      'Lost',
      'Stolen',
      'Retired',
      'Disposed',
      'Sold',
      'Broken',
      'Scrapped',
      'REJECTED',
      'DEAD',
    ].includes(value)
  )
    return 'danger';
  if (
    [
      'PENDING',
      'DISPUTED',
      'HIGH',
      'Under Repair',
      'Under Verification',
      'Damaged',
      'Poor',
      'IN_PROGRESS',
      'SUBMITTED',
      'Out of stock',
    ].includes(value)
  )
    return 'warning';
  if (['In Store', 'Ready to Assign', 'OPEN', 'Leased'].includes(value)) return 'info';
  return 'neutral';
}
export function Badge({
  value,
  label: customLabel,
}: {
  value: string | undefined | null;
  label?: string;
}) {
  const label = customLabel ?? (value ? value.replaceAll('_', ' ').toLowerCase() : 'Unknown');
  const tone = toneClasses[badgeTone(value)];
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ring-1 ring-inset',
        tone.pill,
      )}
    >
      <span className={cx('size-1.5 shrink-0 rounded-full', tone.dot)} aria-hidden="true" />
      {label}
    </span>
  );
}
export function Metric({
  label,
  value,
  detail,
  to,
}: {
  label: string;
  value: number | string | undefined;
  detail?: string;
  to?: string;
}) {
  const content = (
    <>
      <span className="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</span>
      <strong className="text-2xl font-semibold tabular-nums text-navy-900">{value ?? '—'}</strong>
      {detail ? <small className="text-xs text-gray-500">{detail}</small> : null}
    </>
  );
  // `metric` stays as a layout hook for page grids that position these cards.
  const card =
    'metric flex flex-col gap-1 rounded-xl border border-gray-200 bg-white p-4 shadow-none';
  return to ? (
    <Link
      className={cx(
        card,
        'no-underline transition-colors hover:border-navy-300 focus-visible:outline-2 focus-visible:outline-navy-500',
      )}
      to={to}
    >
      {content}
    </Link>
  ) : (
    <div className={card}>{content}</div>
  );
}
export function Panel({
  title,
  children,
  action,
  className = '',
}: PropsWithChildren<{ title?: string; action?: ReactNode; className?: string }>) {
  // `panel` stays as a layout hook for page grids (spans, ordering).
  return (
    <section
      className={cx('panel rounded-xl border border-gray-200 bg-white p-5 shadow-none', className)}
    >
      {title ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-navy-900">{title}</h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}
export function Field({
  label,
  htmlFor,
  children,
  hint,
}: PropsWithChildren<{ label: string; htmlFor: string; hint?: string }>) {
  // `field` stays because page inputs inside are still styled by the legacy layer.
  return (
    <div className="field flex flex-col gap-1.5">
      {label ? (
        <label htmlFor={htmlFor} className="text-sm font-medium text-gray-700">
          {label}
        </label>
      ) : null}
      {children}
      {hint ? <small className="text-xs text-gray-500">{hint}</small> : null}
    </div>
  );
}
export function Checkbox({
  label,
  checked,
  onChange,
  className = '',
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <label
      className={cx(
        'inline-flex cursor-pointer items-center gap-2 text-sm text-gray-700',
        className,
      )}
    >
      <input
        type="checkbox"
        className="size-4 cursor-pointer accent-navy-700"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}
export function Select({
  label,
  htmlFor,
  value,
  onChange,
  options,
  hint,
  disabled = false,
  required = false,
  ariaDescribedBy,
}: {
  label: string;
  htmlFor: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  ariaDescribedBy?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const selectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (selectRef.current && !selectRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const selectedOption = options.find((opt) => opt.value === value);

  return (
    <Field label={label} htmlFor={htmlFor} hint={hint}>
      <div ref={selectRef} className="relative" data-open={isOpen} data-disabled={disabled}>
        <button
          type="button"
          id={htmlFor}
          className={cx(
            'flex h-10 w-full items-center justify-between gap-2 rounded-lg border bg-white px-3 text-left text-sm text-gray-800 transition-colors',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy-500',
            'disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400',
            isOpen ? 'border-navy-500' : 'border-gray-300 hover:border-gray-400',
          )}
          onClick={() => !disabled && setIsOpen(!isOpen)}
          disabled={disabled}
          role="combobox"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          aria-describedby={ariaDescribedBy}
        >
          <span className={cx('truncate', !selectedOption && 'text-gray-400')}>
            {selectedOption ? selectedOption.label : 'Select...'}
          </span>
          <svg
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            className={cx(
              'size-4 shrink-0 text-gray-400 transition-transform',
              isOpen && 'rotate-180',
            )}
            aria-hidden="true"
          >
            <path d="m5 7.5 5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {isOpen && !disabled && (
          <ul
            className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-md"
            role="listbox"
          >
            {options.map((option) => (
              <li
                key={option.value}
                className={cx(
                  'cursor-pointer px-3 py-2 text-sm',
                  option.value === value
                    ? 'bg-navy-50 font-medium text-navy-700'
                    : 'text-gray-700 hover:bg-gray-50',
                  option.disabled && 'cursor-not-allowed opacity-50',
                )}
                onClick={() => {
                  if (!option.disabled) {
                    onChange(option.value);
                    setIsOpen(false);
                  }
                }}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled}
              >
                {option.label}
              </li>
            ))}
          </ul>
        )}
        {required && (
          <input
            type="hidden"
            id={`${htmlFor}-hidden`}
            value={value}
            required={required}
            onChange={() => {}}
          />
        )}
      </div>
    </Field>
  );
}
export function LoadMore({
  available,
  loading,
  onClick,
}: {
  available?: boolean;
  loading?: boolean;
  onClick: () => void;
}) {
  return available ? (
    <button
      className={cx(buttonClass('secondary'), 'mx-auto mt-4 flex')}
      type="button"
      disabled={loading}
      onClick={onClick}
    >
      {loading ? 'Loading...' : 'Load more'}
    </button>
  ) : null;
}
export function displayDate(value: string | null | undefined, withTime = false) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' as const } : {}),
    timeZone: 'Asia/Kolkata',
  }).format(date);
}
export function Timeline({
  items,
}: {
  items: {
    id: string;
    createdAt: string;
    kind?: string;
    type?: string;
    summary?: string;
    body?: string;
    oldStatus?: string | null;
    newStatus?: string | null;
    visibility?: string;
    authorName?: string;
  }[];
}) {
  const titleFor = (item: (typeof items)[number]) => {
    if (item.authorName) return item.authorName;
    const labels: Record<string, string> = {
      CREATED: 'Ticket created',
      STATUS_CHANGED: 'Status changed',
      OWNER_CHANGED: 'Owner changed',
      COMMENT: 'Comment',
      ASSET_CREATED: 'Asset created',
      ASSET_UPDATED: 'Asset updated',
      ASSIGNMENT_CREATED: 'Asset assigned',
      ASSIGNMENT_ENDED: 'Assignment ended',
    };
    const kind = item.kind ?? item.type ?? '';
    return (
      labels[kind] ??
      (kind
        ? kind
            .replaceAll('_', ' ')
            .toLowerCase()
            .replace(/^./, (letter) => letter.toUpperCase())
        : 'Update')
    );
  };
  const bodyFor = (item: (typeof items)[number]) => {
    const body = item.body?.trim() || item.summary?.trim();
    if (item.oldStatus && item.newStatus) {
      const from = item.oldStatus.toLowerCase().replaceAll('_', ' ');
      const to = item.newStatus.toLowerCase().replaceAll('_', ' ');
      const transition = `${from[0].toUpperCase()}${from.slice(1)} → ${to[0].toUpperCase()}${to.slice(1)}`;
      return body ? `${transition} · ${body}` : transition;
    }
    if (body) return body;
    if ((item.kind ?? item.type) === 'OWNER_CHANGED') return 'Ticket owner assignment was updated.';
    return '';
  };
  return items.length ? (
    <ol className="ml-1.5 space-y-5 border-l border-gray-200 pl-5">
      {items.map((item) => (
        <li
          key={item.id}
          className="relative before:absolute before:top-1.5 before:-left-[25px] before:size-2.5 before:rounded-full before:bg-navy-500 before:ring-4 before:ring-white"
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <strong className="font-medium text-gray-900">{titleFor(item)}</strong>
            <time className="text-xs text-gray-500" dateTime={item.createdAt}>
              {displayDate(item.createdAt, true)}
            </time>
            {item.visibility === 'INTERNAL' ? <Badge value="INTERNAL" /> : null}
          </div>
          {bodyFor(item) ? (
            <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{bodyFor(item)}</p>
          ) : null}
        </li>
      ))}
    </ol>
  ) : (
    <p className="text-sm text-gray-500">No history available yet.</p>
  );
}

/**
 * A person shown anywhere in the app: Zoho photo (or initials) and name. Clicking opens a small
 * profile card with a larger photo, designation, department and email.
 */
export function PersonChip({
  userId,
  name,
  hasPhoto,
  detail,
  designation,
  department,
  email,
  size = 28,
}: {
  userId: string;
  name: string;
  hasPhoto?: boolean;
  /** Short second line under the name, e.g. a role or level. */
  detail?: ReactNode;
  designation?: string | null;
  department?: string | null;
  email?: string | null;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <span ref={ref} className="relative inline-flex max-w-full">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`Show profile of ${name}`}
        className="inline-flex max-w-full items-center gap-2 rounded-full py-0.5 pr-2 pl-0.5 text-left transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-navy-500"
      >
        <Avatar userId={userId} name={name} hasPhoto={hasPhoto} size={size} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-gray-900">{name}</span>
          {detail ? <span className="block truncate text-xs text-gray-500">{detail}</span> : null}
        </span>
      </button>
      {open ? (
        <span
          role="dialog"
          aria-label={name}
          className="absolute top-full left-0 z-40 mt-2 flex w-64 flex-col items-center rounded-xl border border-gray-200 bg-white p-5 text-center shadow-lg"
        >
          <Avatar userId={userId} name={name} hasPhoto={hasPhoto} size={88} />
          <span className="mt-3 text-base font-semibold text-navy-900">{name}</span>
          {designation ? <span className="text-sm text-gray-600">{designation}</span> : null}
          {department ? <span className="text-xs text-gray-500">{department}</span> : null}
          {email ? (
            <a
              href={`mailto:${email}`}
              className="mt-3 max-w-full truncate text-xs font-medium text-navy-700 no-underline hover:underline"
            >
              {email}
            </a>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/** Profile photo (served privately by the API) or initials. */
export function Avatar({
  userId,
  name,
  hasPhoto,
  size = 32,
}: {
  userId: string;
  name: string;
  hasPhoto?: boolean;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]!.toUpperCase())
      .join('') || '?';
  const style = { width: size, height: size, fontSize: Math.round(size * 0.4) };
  return hasPhoto && !failed ? (
    <img
      className="shrink-0 rounded-full object-cover ring-1 ring-gray-200"
      style={style}
      src={`/api/v1/users/${userId}/photo`}
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      className="inline-grid shrink-0 place-items-center rounded-full bg-navy-100 font-semibold text-navy-700"
      style={style}
      aria-hidden="true"
    >
      {initials}
    </span>
  );
}
