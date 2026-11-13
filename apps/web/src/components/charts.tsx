import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cx } from './ui';

/*
  Small, brand-consistent chart kit for dashboards (Tailwind only).
  Rules followed: one hue per single-series chart, a validated two-colour pair for two series
  (chart-1 navy, chart-2 sky), thin marks, recessive grid, direct labels, hover detail and a
  table view for every chart.
*/

export function Card({
  title,
  action,
  children,
  className,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx('flex min-w-0 flex-col rounded-xl border border-gray-200 bg-white', className)}
    >
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3.5">
          <h2 className="text-sm font-semibold text-navy-900">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className="flex flex-1 flex-col px-5 py-4">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  detail,
  to,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  to?: string;
}) {
  const body = (
    <>
      <span className="text-xs font-medium text-gray-500">{label}</span>
      <strong className="mt-1 text-2xl leading-tight font-semibold tracking-tight text-navy-900 tabular-nums">
        {value}
      </strong>
      {detail ? <span className="mt-0.5 text-xs text-gray-500">{detail}</span> : null}
    </>
  );
  const base = 'flex min-w-0 flex-col rounded-xl border border-gray-200 bg-white px-4 py-3.5';
  return to ? (
    <Link
      to={to}
      className={cx(
        base,
        'no-underline transition-colors hover:border-navy-300 focus-visible:outline-2 focus-visible:outline-navy-500',
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={base}>{body}</div>
  );
}

export function EmptyChart({ children }: { children: ReactNode }) {
  return (
    <p className="flex flex-1 items-center justify-center py-8 text-center text-sm text-gray-400">
      {children}
    </p>
  );
}

/** Collapsible table view so every chart can be read without the graphic. */
export function TableView({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <details className="group mt-3 text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-gray-500 select-none hover:text-navy-700 [&::-webkit-details-marker]:hidden">
        <svg
          viewBox="0 0 16 16"
          className="size-3 transition-transform group-open:rotate-90"
          aria-hidden="true"
        >
          <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        Table view
      </summary>
      <div className="mt-2 overflow-x-auto rounded-lg border border-gray-100">
        <table className="w-full min-w-0 border-collapse text-left">
          <thead className="bg-gray-50 text-gray-500">
            <tr>
              {headers.map((h, i) => (
                <th key={h} className={cx('px-3 py-1.5 font-medium', i > 0 && 'text-right')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-t border-gray-100">
                {row.map((cell, i) => (
                  <td
                    key={i}
                    className={cx('px-3 py-1.5 text-gray-700', i > 0 && 'text-right tabular-nums')}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export interface BarItem {
  label: string;
  value: number;
  /** Optional secondary text shown after the value, e.g. a share or amount. */
  note?: string;
  to?: string;
}

/** Ranked horizontal bars: label above, thin bar, value right. Single hue. */
export function BarList({
  items,
  format = (n) => n.toLocaleString('en-IN'),
  empty = 'No data yet',
  valueLabel = 'Value',
  limit = 8,
}: {
  items: BarItem[];
  format?: (value: number) => string;
  empty?: string;
  valueLabel?: string;
  limit?: number;
}) {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const shown =
    sorted.length > limit
      ? [
          ...sorted.slice(0, limit - 1),
          { label: 'Other', value: sorted.slice(limit - 1).reduce((s, i) => s + i.value, 0) },
        ]
      : sorted;
  const max = Math.max(0, ...shown.map((i) => i.value));
  if (!shown.length || max === 0) return <EmptyChart>{empty}</EmptyChart>;
  return (
    <>
      <ul className="flex flex-col gap-3">
        {shown.map((item) => {
          const row = (
            <>
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate text-gray-700" title={item.label}>
                  {item.label}
                </span>
                <span className="shrink-0 font-medium text-gray-900 tabular-nums">
                  {format(item.value)}
                  {item.note ? (
                    <span className="ml-1.5 font-normal text-gray-400">{item.note}</span>
                  ) : null}
                </span>
              </span>
              <span className="mt-1.5 block h-1.5 rounded-full bg-gray-100">
                <span
                  className="block h-1.5 rounded-full bg-chart-1 transition-colors group-hover:bg-navy-700"
                  style={{ width: `${Math.max(2, (item.value / max) * 100)}%` }}
                />
              </span>
            </>
          );
          return (
            <li key={item.label} title={`${item.label}: ${format(item.value)}`}>
              {item.to ? (
                <Link to={item.to} className="group block rounded-md no-underline">
                  {row}
                </Link>
              ) : (
                <div className="group">{row}</div>
              )}
            </li>
          );
        })}
      </ul>
      <TableView
        headers={['Name', valueLabel]}
        rows={shown.map((i) => [i.label, format(i.value)])}
      />
    </>
  );
}

/** Vertical columns for a short ordered series (e.g. financial years). Single hue, hover detail. */
export function ColumnChart({
  items,
  format,
  shortFormat = format,
  empty = 'No data yet',
  valueLabel = 'Value',
  labelHeader = 'Period',
}: {
  items: { label: string; value: number; detail?: string }[];
  format: (value: number) => string;
  shortFormat?: (value: number) => string;
  empty?: string;
  valueLabel?: string;
  labelHeader?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(0, ...items.map((i) => i.value));
  if (!items.length || max === 0) return <EmptyChart>{empty}</EmptyChart>;
  return (
    <>
      <div
        className="relative flex h-44 items-end gap-3 border-b border-gray-200 pt-6"
        role="img"
        aria-label={items.map((i) => `${i.label}: ${format(i.value)}`).join('; ')}
      >
        {items.map((item, index) => (
          <div
            key={item.label}
            className="relative flex h-full flex-1 flex-col items-center justify-end"
            onMouseEnter={() => setHover(index)}
            onMouseLeave={() => setHover(null)}
          >
            <span
              className={cx(
                'mb-1 text-[11px] tabular-nums',
                hover === index || index === items.length - 1
                  ? 'font-medium text-gray-700'
                  : 'text-gray-400',
              )}
            >
              {shortFormat(item.value)}
            </span>
            <span
              className={cx(
                'w-full max-w-12 rounded-t-[4px] transition-colors',
                hover === index ? 'bg-navy-700' : 'bg-chart-1',
              )}
              style={{ height: `${Math.max(2, (item.value / max) * 100)}%` }}
            />
            {hover === index && item.detail ? (
              <span className="pointer-events-none absolute -top-2 z-10 -translate-y-full rounded-md bg-navy-950 px-2 py-1 text-[11px] whitespace-nowrap text-white">
                {item.detail}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-3">
        {items.map((item) => (
          <span key={item.label} className="flex-1 truncate text-center text-[11px] text-gray-500">
            {item.label}
          </span>
        ))}
      </div>
      <TableView
        headers={[labelHeader, valueLabel]}
        rows={items.map((i) => [i.label, format(i.value)])}
      />
    </>
  );
}

/*
  Categorical slots for part-of-whole charts, in fixed order (never cycled). Validated
  for colour-blind separation on the light chart surface (dataviz reference palette).
  Slices beyond the slots fold into a grey "Other".
*/
const SLICE_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300'];
const OTHER_COLOR = '#a8a7a1';

function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const p = (r: number, a: number) => `${cx + r * Math.sin(a)} ${cy - r * Math.cos(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${p(r1, a0)} A ${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L ${p(r0, a1)} A ${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

/** Part-of-whole donut: thin ring, surface gaps between slices, legend with counts and shares. */
export function DonutChart({
  items,
  format = (n) => n.toLocaleString('en-IN'),
  empty = 'No data yet',
  valueLabel = 'Value',
  labelHeader = 'Name',
  centerLabel = 'Total',
}: {
  items: { label: string; value: number; to?: string }[];
  format?: (value: number) => string;
  empty?: string;
  valueLabel?: string;
  labelHeader?: string;
  centerLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const positive = items.filter((i) => i.value > 0);
  const total = positive.reduce((sum, i) => sum + i.value, 0);
  if (!total) return <EmptyChart>{empty}</EmptyChart>;
  // Keep the given order; fold anything past the colour slots into Other.
  const shown = positive.length > SLICE_COLORS.length
    ? [
        ...positive.slice(0, SLICE_COLORS.length - 1),
        {
          label: 'Other',
          value: positive.slice(SLICE_COLORS.length - 1).reduce((s, i) => s + i.value, 0),
        },
      ]
    : positive;
  const color = (index: number, label: string) =>
    label === 'Other' && index === shown.length - 1 && positive.length > SLICE_COLORS.length
      ? OTHER_COLOR
      : SLICE_COLORS[index];
  const pct = (v: number) => `${Math.round((v / total) * 100)}%`;
  const gap = shown.length > 1 ? 0.035 : 0; // ~2px surface gap at this size
  let angle = 0;
  const slices = shown.map((item, index) => {
    const sweep = (item.value / total) * Math.PI * 2;
    const a0 = angle + gap / 2;
    const a1 = angle + sweep - gap / 2;
    angle += sweep;
    return { item, index, path: sweep >= Math.PI * 2 - 0.001 ? null : arc(60, 60, 40, 56, a0, Math.max(a0 + 0.001, a1)) };
  });
  const focus = hover === null ? null : shown[hover];
  return (
    <>
      <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
        <div className="relative size-36 shrink-0">
          <svg
            viewBox="0 0 120 120"
            className="size-full"
            role="img"
            aria-label={shown.map((i) => `${i.label}: ${format(i.value)} (${pct(i.value)})`).join('; ')}
          >
            {slices.map(({ item, index, path }) =>
              path ? (
                <path
                  key={item.label}
                  d={path}
                  fill={color(index, item.label)}
                  opacity={hover === null || hover === index ? 1 : 0.35}
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                />
              ) : (
                <circle
                  key={item.label}
                  cx="60"
                  cy="60"
                  r="48"
                  fill="none"
                  stroke={color(index, item.label)}
                  strokeWidth="16"
                  onMouseEnter={() => setHover(index)}
                  onMouseLeave={() => setHover(null)}
                />
              ),
            )}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-lg font-medium text-gray-900 tabular-nums">
              {format(focus ? focus.value : total)}
            </span>
            <span className="max-w-20 truncate text-[11px] text-gray-500">
              {focus ? `${focus.label} · ${pct(focus.value)}` : centerLabel}
            </span>
          </div>
        </div>
        <ul className="w-full min-w-0 flex-1 space-y-1.5 text-sm">
          {shown.map((item, index) => {
            const row = (
              <>
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: color(index, item.label) }}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate text-gray-700">{item.label}</span>
                <span className="font-medium text-gray-900 tabular-nums">{format(item.value)}</span>
                <span className="w-10 text-right text-xs text-gray-500 tabular-nums">{pct(item.value)}</span>
              </>
            );
            const to = (item as { to?: string }).to;
            return (
              <li
                key={item.label}
                onMouseEnter={() => setHover(index)}
                onMouseLeave={() => setHover(null)}
                className={cx('rounded-md px-1.5 py-0.5', hover === index && 'bg-gray-50')}
              >
                {to ? (
                  <Link to={to} className="flex items-center gap-2 no-underline">
                    {row}
                  </Link>
                ) : (
                  <span className="flex items-center gap-2">{row}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <TableView
        headers={[labelHeader, valueLabel, 'Share']}
        rows={shown.map((i) => [i.label, format(i.value), pct(i.value)])}
      />
    </>
  );
}

/** Two-series weekly line chart with a crosshair tooltip and direct end labels. */
export function TwoLineChart({
  points,
  series,
  xLabel,
  empty = 'No activity yet',
}: {
  points: { key: string; label: string; a: number; b: number }[];
  series: [string, string];
  xLabel: (key: string) => string;
  empty?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.some((p) => p.a || p.b)) return <EmptyChart>{empty}</EmptyChart>;
  const W = 640;
  const H = 200;
  const L = 28;
  const R = 84;
  const T = 12;
  const B = 26;
  const max = Math.max(1, ...points.flatMap((p) => [p.a, p.b]));
  const niceMax = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(points.length - 1, 1);
  const y = (v: number) => T + ((niceMax - v) * (H - T - B)) / niceMax;
  const path = (key: 'a' | 'b') =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[key])}`).join(' ');
  const last = points.length - 1;
  const ticks = [0, 0.5, 1].map((f) => Math.round(niceMax * f));
  const hp = hover === null ? null : points[hover]!;
  return (
    <>
      <div className="mb-2 flex items-center gap-4 text-xs text-gray-600">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-chart-1" /> {series[0]}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-chart-2" /> {series[1]}
        </span>
      </div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-auto w-full overflow-visible"
          role="img"
          aria-label={`${series[0]} and ${series[1]} per week. Total ${series[0].toLowerCase()} ${points.reduce((s, p) => s + p.a, 0)}, ${series[1].toLowerCase()} ${points.reduce((s, p) => s + p.b, 0)}.`}
          onMouseLeave={() => setHover(null)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={L}
                x2={W - R}
                y1={y(t)}
                y2={y(t)}
                className="stroke-gray-100"
                strokeWidth={1}
              />
              <text x={L - 8} y={y(t) + 4} textAnchor="end" className="fill-gray-400 text-[10px]">
                {t}
              </text>
            </g>
          ))}
          {hp ? (
            <line
              x1={x(hover!)}
              x2={x(hover!)}
              y1={T}
              y2={H - B}
              className="stroke-gray-300"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          ) : null}
          <path
            d={path('a')}
            fill="none"
            className="stroke-chart-1"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <path
            d={path('b')}
            fill="none"
            className="stroke-chart-2"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          {hp ? (
            <>
              <circle
                cx={x(hover!)}
                cy={y(hp.a)}
                r={4}
                className="fill-chart-1 stroke-white"
                strokeWidth={2}
              />
              <circle
                cx={x(hover!)}
                cy={y(hp.b)}
                r={4}
                className="fill-chart-2 stroke-white"
                strokeWidth={2}
              />
            </>
          ) : null}
          <text x={W - R + 8} y={y(points[last]!.a) + 4} className="fill-gray-600 text-[11px]">
            {series[0]} {points[last]!.a}
          </text>
          <text
            x={W - R + 8}
            y={
              y(points[last]!.b) + (Math.abs(y(points[last]!.a) - y(points[last]!.b)) < 12 ? 16 : 4)
            }
            className="fill-gray-600 text-[11px]"
          >
            {series[1]} {points[last]!.b}
          </text>
          {points.map((p, i) =>
            i % 2 === last % 2 ? (
              <text
                key={p.key}
                x={x(i)}
                y={H - 6}
                textAnchor="middle"
                className="fill-gray-400 text-[10px]"
              >
                {p.label}
              </text>
            ) : null,
          )}
          {points.map((p, i) => (
            <rect
              key={`hit-${p.key}`}
              x={x(i) - (W - L - R) / Math.max(points.length - 1, 1) / 2}
              y={T}
              width={(W - L - R) / Math.max(points.length - 1, 1)}
              height={H - T - B}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}
        </svg>
        {hp ? (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-md bg-navy-950 px-2.5 py-1.5 text-[11px] leading-relaxed text-white"
            style={{
              left: `${(x(hover!) / W) * 100}%`,
              transform:
                hover! > points.length / 2 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            }}
          >
            <div className="font-medium">{xLabel(hp.key)}</div>
            <div>
              {series[0]}: {hp.a}
            </div>
            <div>
              {series[1]}: {hp.b}
            </div>
          </div>
        ) : null}
      </div>
      <TableView
        headers={['Week', series[0], series[1]]}
        rows={points.map((p) => [xLabel(p.key), p.a, p.b])}
      />
    </>
  );
}
