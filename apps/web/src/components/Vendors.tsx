import { useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { formatInr } from '../admin-insights';
import { useAction } from '../hooks';
import { can, useSession } from '../session';
import type { AssignablePerson, User } from '../types';
import { StatTile } from './charts';
import { PersonPicker } from './PersonPicker';
import { ColumnFilter, FilterChips, FiltersButton, SortMenu, fromList, toList, type FilterGroup } from './ColumnFilter';
import { canViewSubscriptions } from './Subscriptions';
import {
  Avatar,
  Badge,
  Checkbox,
  Empty,
  ErrorNotice,
  Field,
  Loading,
  PageTitle,
  Panel,
  PersonChip,
  Select,
  backLinkClass,
  buttonClass,
  cx,
  displayDate,
  inputClass,
  tableClass,
  tableWrapClass,
} from './ui';

/* ------------------------------------------------------------- access */

/** Super Admin, team leads and members, Finance and Procurement add and edit vendors. */
export function canManageVendors(user: User | undefined) {
  return !!user && (user.roles.some((r) => ['SUPER_ADMIN', 'FINANCE', 'PROCUREMENT'].includes(r)) || (user.teams ?? []).length > 0);
}
export function canViewVendors(user: User | undefined) {
  return canManageVendors(user) || can(user, 'asset.view_all') || can(user, 'report.view');
}

/* -------------------------------------------------------------- types */

interface RefPerson {
  userId: string;
  name: string;
  hasPhoto: boolean;
  designation?: string | null;
}
interface Vendor {
  id: string;
  code: string;
  name: string;
  services: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  website: string | null;
  gstin: string | null;
  score: number | null;
  status: 'ACTIVE' | 'INACTIVE';
  notes: string | null;
  referencePeople: RefPerson[];
  assetCount: number | null;
  assetValue: number | null;
  subscriptionCount: number | null;
  version: number;
  createdAt?: string;
}
interface VendorDetailData extends Vendor {
  createdBy: string | null;
  canManage: boolean;
  showsMoney: boolean;
  assets: {
    id: string;
    assetCode: string;
    description: string;
    category: string;
    assetType: string;
    manufacturer: string | null;
    model: string | null;
    status: string;
    purchaseDate: string | null;
    purchaseCost: number | null;
    invoiceNumber: string | null;
    warrantyExpiry: string | null;
    holder: { userId: string; name: string; hasPhoto: boolean } | null;
  }[];
  subscriptions: { id: string; name: string; plan: string | null; status: string; renewalDate: string | null; cost: number | null; currency: string; billingCycle: string }[] | null;
}

/** Score out of 10 as a coloured pill: green 8+, amber 6–7.9, red below 6. */
function ScorePill({ score }: { score: number | null }) {
  if (score == null) return <span className="text-gray-400">Not rated</span>;
  const tone = score >= 8 ? 'bg-sky-50 text-sky-800 ring-sky-100' : score >= 6 ? 'bg-yellow-50 text-yellow-800 ring-yellow-200' : 'bg-red-50 text-red-700 ring-red-100';
  return (
    <span className={cx('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset', tone)}>
      {score.toFixed(score % 1 ? 1 : 0)} / 10
    </span>
  );
}

function PeopleStack({ people }: { people: RefPerson[] }) {
  if (!people.length) return <span className="text-gray-400">—</span>;
  return (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-2">
        {people.slice(0, 3).map((p) => (
          <span key={p.userId} title={p.name} className="rounded-full ring-2 ring-white">
            <Avatar userId={p.userId} name={p.name} hasPhoto={p.hasPhoto} size={26} />
          </span>
        ))}
      </div>
      <span className="truncate text-sm text-gray-700">{people.map((p) => p.name.split(' ')[0]).join(', ')}</span>
    </div>
  );
}

const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;
const firstPhone = (phone: string | null) => phone?.split(/[\/,;\n]/)[0]?.trim() || null;
const firstEmail = (email: string | null) => email?.split(/[\s,;\/]+/).find((e) => e.includes('@')) ?? null;

/* --------------------------------------------------------------- list */

/** Columns the vendor list can show; the vendor column (name, code) is always on. */
const vendorColumns = [
  { key: 'services', label: 'Provides' },
  { key: 'contact', label: 'Contact' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'address', label: 'Address' },
  { key: 'reference', label: 'Our reference' },
  { key: 'score', label: 'Score' },
  { key: 'assets', label: 'Assets' },
  { key: 'value', label: 'Value supplied' },
  { key: 'subscriptions', label: 'Subscriptions' },
  { key: 'gstin', label: 'GSTIN' },
  { key: 'website', label: 'Website' },
  { key: 'status', label: 'Status' },
] as const;
type VendorColumn = (typeof vendorColumns)[number]['key'];
const defaultVendorColumns: VendorColumn[] = ['services', 'contact', 'reference', 'score', 'assets', 'status'];
const VENDOR_FILTERS = ['score', 'reference', 'supplied', 'status'] as const;
type VendorFilter = (typeof VENDOR_FILTERS)[number];
const scoreBand = (v: Vendor) => (v.score == null ? 'none' : v.score >= 8 ? 'high' : v.score >= 6 ? 'mid' : 'low');

export function VendorList() {
  const { user } = useSession();
  const manage = canManageVendors(user);
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';
  const sort = params.get('sort') ?? 'name';
  const sel = (key: VendorFilter) => toList(params.get(key));
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  useEffect(() => {
    const timer = setTimeout(() => search.trim() !== q && update('q', search.trim()), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  // The server searches; filters and sort run here (every status is loaded).
  const query = useQuery({
    queryKey: ['vendors', q],
    queryFn: ({ signal }) =>
      api<{ items: Vendor[]; showsSubscriptions: boolean; showsMoney: boolean }>(`/vendors?status=ALL${q ? `&q=${encodeURIComponent(q)}` : ''}`, { signal }),
    placeholderData: (previous) => previous,
  });
  const [columns, setColumns] = useState<VendorColumn[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('vendor-columns-v1') ?? 'null');
      return Array.isArray(saved) ? (saved.filter((k) => vendorColumns.some((c) => c.key === k)) as VendorColumn[]) : defaultVendorColumns;
    } catch {
      return defaultVendorColumns;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('vendor-columns-v1', JSON.stringify(columns));
    } catch {
      // Column choice still applies for this visit if storage is unavailable.
    }
  }, [columns]);
  const all = query.data?.items ?? [];
  const showsMoney = !!query.data?.showsMoney;
  const showsSubs = !!query.data?.showsSubscriptions;
  const people = new Map<string, string>();
  for (const v of all) for (const p of v.referencePeople) people.set(p.userId, p.name);
  const count = (pred: (v: Vendor) => boolean) => all.filter(pred).length;
  const groups: FilterGroup[] = [
    {
      key: 'score',
      title: 'Score',
      options: [
        { value: 'high', label: `8 and above (${count((v) => scoreBand(v) === 'high')})` },
        { value: 'mid', label: `6 to 7.9 (${count((v) => scoreBand(v) === 'mid')})` },
        { value: 'low', label: `Below 6 (${count((v) => scoreBand(v) === 'low')})` },
        { value: 'none', label: `Not rated (${count((v) => scoreBand(v) === 'none')})` },
      ],
      selected: sel('score'),
    },
    {
      key: 'reference',
      title: 'Our reference',
      options: [...people.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => ({ value: id, label: `${name} (${count((v) => v.referencePeople.some((p) => p.userId === id))})` })),
      selected: sel('reference'),
    },
    {
      key: 'supplied',
      title: 'Assets',
      options: [
        { value: 'yes', label: `Supplied our assets (${count((v) => (v.assetCount ?? 0) > 0)})` },
        { value: 'no', label: `No assets yet (${count((v) => !v.assetCount)})` },
      ],
      selected: sel('supplied'),
    },
    {
      key: 'status',
      title: 'Status',
      options: [
        { value: 'ACTIVE', label: `Active (${count((v) => v.status === 'ACTIVE')})` },
        { value: 'INACTIVE', label: `Inactive (${count((v) => v.status === 'INACTIVE')})` },
      ],
      selected: sel('status'),
    },
  ];
  const matches = (v: Vendor) =>
    (!sel('score').length || sel('score').includes(scoreBand(v))) &&
    (!sel('reference').length || v.referencePeople.some((p) => sel('reference').includes(p.userId))) &&
    (!sel('supplied').length || sel('supplied').includes((v.assetCount ?? 0) > 0 ? 'yes' : 'no')) &&
    (!sel('status').length || sel('status').includes(v.status));
  const items = all.filter(matches).sort((a, b) =>
    sort === 'score'
      ? (b.score ?? -1) - (a.score ?? -1) || a.name.localeCompare(b.name)
      : sort === 'assets'
        ? (b.assetCount ?? 0) - (a.assetCount ?? 0) || a.name.localeCompare(b.name)
        : sort === 'recent'
          ? (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
          : a.name.localeCompare(b.name),
  );
  const rated = items.filter((v) => v.score != null);
  const avg = rated.length ? rated.reduce((s, v) => s + (v.score ?? 0), 0) / rated.length : null;
  const supplying = items.filter((v) => (v.assetCount ?? 0) > 0).length;
  const value = items.reduce((s, v) => s + (v.assetValue ?? 0), 0);
  const setFilter = (key: string, values: string[]) => update(key, fromList(values));
  const applyFilters = (next: Record<string, string[]>) => {
    const p = new URLSearchParams(params);
    for (const [key, values] of Object.entries(next)) {
      if (values.length) p.set(key, fromList(values));
      else p.delete(key);
    }
    setParams(p, { replace: true });
  };
  const allowed = vendorColumns.filter(
    (c) => (c.key !== 'value' || showsMoney) && (c.key !== 'subscriptions' || showsSubs),
  );
  const shown = allowed.filter((c) => columns.includes(c.key));
  const filterFor: Partial<Record<VendorColumn, VendorFilter>> = { score: 'score', reference: 'reference', assets: 'supplied', status: 'status' };
  const numeric = (key: VendorColumn) => key === 'assets' || key === 'value' || key === 'subscriptions';
  const header = (key: VendorColumn, label: string) => {
    const fk = filterFor[key];
    const group = fk ? groups.find((g) => g.key === fk) : undefined;
    return (
      <th key={key} className={numeric(key) ? 'text-right' : undefined}>
        <span className="inline-flex items-center gap-1">
          {label}
          {group ? <ColumnFilter title={label} options={group.options} selected={group.selected} onApply={(vals) => setFilter(group.key, vals)} /> : null}
        </span>
      </th>
    );
  };
  const cell = (v: Vendor, key: VendorColumn): ReactNode => {
    const phone = firstPhone(v.phone);
    const email = firstEmail(v.email);
    switch (key) {
      case 'services':
        return <span className="block max-w-64 text-sm">{v.services ?? '—'}</span>;
      case 'contact':
        return (
          <span className="text-sm">
            <span className="block text-gray-900">{v.contactPerson ?? '—'}</span>
            {phone && !columns.includes('phone') ? (
              <a href={telHref(phone)} className="text-xs text-navy-700 tabular-nums">
                {phone}
              </a>
            ) : null}
          </span>
        );
      case 'phone':
        return phone ? (
          <a href={telHref(phone)} className="text-sm whitespace-nowrap text-navy-700 tabular-nums">
            {v.phone}
          </a>
        ) : (
          '—'
        );
      case 'email':
        return email ? (
          <a href={`mailto:${email}`} className="block max-w-56 truncate text-sm text-navy-700">
            {v.email}
          </a>
        ) : (
          '—'
        );
      case 'address':
        return <span className="block max-w-64 text-sm text-gray-600">{v.address ?? '—'}</span>;
      case 'reference':
        return <PeopleStack people={v.referencePeople} />;
      case 'score':
        return <ScorePill score={v.score} />;
      case 'assets':
        return <span className="tabular-nums">{v.assetCount || <span className="text-gray-400">0</span>}</span>;
      case 'value':
        return <span className="tabular-nums">{v.assetValue ? formatInr(v.assetValue) : '—'}</span>;
      case 'subscriptions':
        return <span className="tabular-nums">{v.subscriptionCount || <span className="text-gray-400">0</span>}</span>;
      case 'gstin':
        return <span className="font-mono text-xs">{v.gstin ?? '—'}</span>;
      case 'website':
        return v.website ? (
          <a href={/^https?:\/\//i.test(v.website) ? v.website : `https://${v.website}`} target="_blank" rel="noreferrer noopener" className="text-sm text-navy-700">
            {v.website}
          </a>
        ) : (
          '—'
        );
      case 'status':
        return <Badge value={v.status} label={v.status === 'ACTIVE' ? 'Active' : 'Inactive'} />;
    }
  };
  const filtering = VENDOR_FILTERS.some((k) => sel(k).length) || !!q;

  return (
    <>
      <PageTitle
        eyebrow="ASSETS"
        title="Vendors"
        description="Companies we buy from or work with, who to call, who deals with them on our side, and everything they supplied."
        action={
          manage ? (
            <Link to="/vendors/new" className={buttonClass()}>
              Add vendor
            </Link>
          ) : undefined
        }
      />
      <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Vendors" value={String(items.length)} detail={filtering ? `Of ${all.length} in total` : `${count((v) => v.status === 'ACTIVE')} active`} />
        <StatTile label="Average score" value={avg == null ? '—' : `${avg.toFixed(1)} / 10`} detail={`${rated.length} rated`} />
        <StatTile label="Supplied our assets" value={String(supplying)} detail="Linked by supplier name" />
        {showsMoney ? <StatTile label="Value supplied" value={formatInr(value)} detail="Purchase cost of their assets" /> : null}
      </div>
      <Panel title="All vendors" action={<span className="text-sm text-gray-500">{items.length} of {all.length} shown</span>}>
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            className={cx(inputClass, 'min-w-56 flex-1')}
            placeholder="Search company, service, contact, phone, email or address"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search vendors"
          />
          <SortMenu
            value={sort}
            onChange={(value) => update('sort', value === 'name' ? '' : value)}
            options={[
              { value: 'name', label: 'Name (A–Z)' },
              { value: 'score', label: 'Highest score' },
              { value: 'assets', label: 'Most assets supplied' },
              { value: 'recent', label: 'Recently added' },
            ]}
          />
          <details className="relative">
            <summary className={cx(buttonClass('secondary'), 'cursor-pointer list-none whitespace-nowrap')}>Columns ({shown.length + 1})</summary>
            <div className="absolute right-0 z-20 mt-1 max-h-80 w-56 overflow-auto rounded-lg border border-gray-200 bg-white p-3 shadow-lg">
              <div className="mb-2 flex justify-between border-b border-gray-100 pb-2 text-xs">
                <button type="button" className="font-medium text-navy-700" onClick={() => setColumns(allowed.map((c) => c.key))}>
                  Select all
                </button>
                <button type="button" className="font-medium text-navy-700" onClick={() => setColumns(defaultVendorColumns)}>
                  Reset
                </button>
              </div>
              {allowed.map((column) => (
                <div key={column.key} className="py-1.5">
                  <Checkbox
                    label={column.label}
                    checked={columns.includes(column.key)}
                    onChange={(checked) => setColumns((current) => (checked ? [...current, column.key] : current.filter((k) => k !== column.key)))}
                  />
                </div>
              ))}
            </div>
          </details>
          {/* Phones hide the table headers, so their filters live behind this button. */}
          <div className="md:hidden">
            <FiltersButton groups={groups} onApply={applyFilters} />
          </div>
        </div>
        <FilterChips
          groups={groups}
          onRemove={(key, val) => setFilter(key, sel(key as VendorFilter).filter((x) => x !== val))}
          onClearAll={() => {
            const p = new URLSearchParams(params);
            VENDOR_FILTERS.forEach((k) => p.delete(k));
            setParams(p, { replace: true });
          }}
        />
        {query.isPending ? (
          <Loading />
        ) : items.length ? (
          <div className={tableWrapClass}>
            <table className={tableClass}>
              <thead>
                <tr>
                  <th>Vendor</th>
                  {shown.map((c) => header(c.key, c.label))}
                </tr>
              </thead>
              <tbody>
                {items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link to={`/vendors/${v.id}`} className="block font-medium text-navy-700 no-underline hover:underline">
                        {v.name}
                      </Link>
                      <span className="font-mono text-xs text-gray-400">{v.code}</span>
                    </td>
                    {shown.map((c) => (
                      <td key={c.key} className={numeric(c.key) ? 'text-right' : undefined}>
                        {cell(v, c.key)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={filtering ? 'Nothing matches' : 'No vendors yet'}
            action={
              manage && !filtering ? (
                <Link to="/vendors/new" className={buttonClass()}>
                  Add the first vendor
                </Link>
              ) : undefined
            }
          >
            {filtering ? 'Try another filter or clear the search.' : 'Add the companies you buy from. Assets whose supplier matches a vendor’s name link to it automatically.'}
          </Empty>
        )}
      </Panel>
    </>
  );
}

/* --------------------------------------------------------------- form */

interface FormState {
  name: string;
  services: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  website: string;
  gstin: string;
  score: string;
  status: 'ACTIVE' | 'INACTIVE';
  notes: string;
}
const emptyForm: FormState = {
  name: '',
  services: '',
  contactPerson: '',
  phone: '',
  email: '',
  address: '',
  website: '',
  gstin: '',
  score: '',
  status: 'ACTIVE',
  notes: '',
};

export function VendorForm() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const { user } = useSession();
  const client = useQueryClient();
  const action = useAction<{ id: string }>();
  const existing = useQuery({
    queryKey: ['vendor', id],
    queryFn: ({ signal }) => api<VendorDetailData>(`/vendors/${id}`, { signal }),
    enabled: editing,
  });
  const [form, setForm] = useState<FormState>(emptyForm);
  const [people, setPeople] = useState<RefPerson[]>([]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const candidates = useQuery({
    queryKey: ['assignable-people', 'vendor', q],
    queryFn: ({ signal }) => api<{ items: AssignablePerson[] }>(`/assignable-people?limit=25${q ? `&q=${encodeURIComponent(q)}` : ''}`, { signal }),
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    const v = existing.data;
    if (!v) return;
    setForm({
      name: v.name,
      services: v.services ?? '',
      contactPerson: v.contactPerson ?? '',
      phone: v.phone ?? '',
      email: v.email ?? '',
      address: v.address ?? '',
      website: v.website ?? '',
      gstin: v.gstin ?? '',
      score: v.score != null ? String(v.score) : '',
      status: v.status,
      notes: v.notes ?? '',
    });
    setPeople(v.referencePeople);
  }, [existing.data]);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }));

  if (!canManageVendors(user)) return <Empty title="Access required">Only team members, Finance or Procurement can add or change vendors.</Empty>;
  if (editing && existing.isPending) return <Loading label="Loading vendor…" />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (action.isPending) return;
    const body = {
      name: form.name.trim(),
      services: form.services.trim() || null,
      contactPerson: form.contactPerson.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim() || null,
      address: form.address.trim() || null,
      website: form.website.trim() || null,
      gstin: form.gstin.trim() || null,
      score: form.score.trim() ? Number(form.score) : null,
      status: form.status,
      notes: form.notes.trim() || null,
      referenceUserIds: people.map((p) => p.userId),
      ...(editing ? { version: existing.data!.version } : {}),
    };
    try {
      const result = await action.mutateAsync({ path: editing ? `/vendors/${id}` : '/vendors', method: editing ? 'PUT' : 'POST', body });
      void client.invalidateQueries({ queryKey: ['vendors'] });
      void client.invalidateQueries({ queryKey: ['vendor', id] });
      navigate(`/vendors/${editing ? id : result.id}`);
    } catch {
      /* shown by ErrorNotice */
    }
  }

  const input = (key: keyof FormState, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}, hint?: string) => (
    <Field label={label} htmlFor={`vendor-${key}`} hint={hint}>
      <input id={`vendor-${key}`} className={inputClass} value={form[key] as string} onChange={(e) => update(key, e.target.value as never)} {...props} />
    </Field>
  );
  const section = (title: string, children: ReactNode, hint?: string) => (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <h2 className="text-base font-semibold text-navy-900">{title}</h2>
      {hint ? <p className="mt-0.5 mb-4 text-sm text-gray-500">{hint}</p> : <div className="mb-4" />}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );

  return (
    <>
      <Link to={editing ? `/vendors/${id}` : '/vendors'} className={backLinkClass}>
        ← {editing ? 'Back to vendor' : 'Vendors'}
      </Link>
      <PageTitle eyebrow="ASSETS / VENDORS" title={editing ? `Edit ${existing.data?.name ?? 'vendor'}` : 'Add vendor'} />
      <form className="flex flex-col gap-6" onSubmit={(e) => void submit(e)}>
        <ErrorNotice error={action.error} />
        {section(
          'Company',
          <>
            {input('name', 'Company name', { required: true, maxLength: 200, placeholder: 'For example: Optima Infotech' }, 'Assets whose Supplier matches this name link to the vendor.')}
            {input('services', 'What they provide', { maxLength: 500, placeholder: 'For example: All IT and other services' })}
            <Select
              label="Status"
              htmlFor="vendor-status"
              value={form.status}
              onChange={(v) => update('status', v as FormState['status'])}
              options={[
                { value: 'ACTIVE', label: 'Active' },
                { value: 'INACTIVE', label: 'Inactive (no longer used)' },
              ]}
            />
            {input('website', 'Website', { maxLength: 500, placeholder: 'For example: optimainfotech.com' })}
            {input('gstin', 'GSTIN (optional)', { maxLength: 20 })}
            {input('score', 'Score (0–10)', { type: 'number', min: 0, max: 10, step: '0.5', inputMode: 'decimal', placeholder: 'Not rated' }, 'Our rating: price, service and reliability.')}
          </>,
        )}
        {section(
          'Contact',
          <>
            {input('contactPerson', 'Contact person', { maxLength: 200, placeholder: 'For example: Anil Bader' })}
            {input('phone', 'Phone', { maxLength: 100, inputMode: 'tel', placeholder: 'For example: 9830040965' }, 'Several numbers can be separated with /')}
            {input('email', 'Email', { maxLength: 500, placeholder: 'name@company.com' })}
            <div className="sm:col-span-2 lg:col-span-3">
              <Field label="Address" htmlFor="vendor-address">
                <textarea
                  id="vendor-address"
                  className={cx(inputClass, 'h-auto py-2')}
                  rows={2}
                  maxLength={1000}
                  value={form.address}
                  onChange={(e) => update('address', e.target.value)}
                />
              </Field>
            </div>
          </>,
        )}
        <section className="rounded-xl border border-gray-200 bg-white p-5">
          <h2 className="text-base font-semibold text-navy-900">Our reference people</h2>
          <p className="mt-0.5 mb-4 text-sm text-gray-500">The staff who deal with this vendor. Pick one or more.</p>
          <div className="max-w-2xl">
            <PersonPicker
              label="Add a person"
              people={(candidates.data?.items ?? []).filter((p) => !people.some((x) => x.userId === p.id))}
              loading={candidates.isFetching}
              search={search}
              onSearch={setSearch}
              selected={undefined}
              onSelect={(p) => {
                if (p && !people.some((x) => x.userId === p.id)) setPeople([...people, { userId: p.id, name: p.displayName, hasPhoto: p.hasPhoto }]);
                setSearch('');
              }}
            />
            {people.length ? (
              <ul className="mt-3 flex flex-wrap gap-2">
                {people.map((p) => (
                  <li key={p.userId} className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white py-1 pr-1.5 pl-1">
                    <Avatar userId={p.userId} name={p.name} hasPhoto={p.hasPhoto} size={24} />
                    <span className="text-sm text-gray-800">{p.name}</span>
                    <button
                      type="button"
                      className="rounded-full px-1.5 text-gray-400 hover:bg-gray-100 hover:text-red-700"
                      aria-label={`Remove ${p.name}`}
                      onClick={() => setPeople(people.filter((x) => x.userId !== p.userId))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="mt-5">
            <Field label="Notes (optional)" htmlFor="vendor-notes">
              <textarea
                id="vendor-notes"
                className={cx(inputClass, 'h-auto py-2')}
                rows={2}
                maxLength={5000}
                value={form.notes}
                onChange={(e) => update('notes', e.target.value)}
                placeholder="For example: First time engagement, good for urgent printer repairs"
              />
            </Field>
          </div>
        </section>
        <div className="flex flex-wrap justify-end gap-2">
          <Link to={editing ? `/vendors/${id}` : '/vendors'} className={buttonClass('secondary')}>
            Cancel
          </Link>
          <button type="submit" className={buttonClass()} disabled={action.isPending || !form.name.trim()}>
            {action.isPending ? 'Saving…' : editing ? 'Save changes' : 'Add vendor'}
          </button>
        </div>
      </form>
    </>
  );
}

/* ------------------------------------------------------------- detail */

export function VendorDetail() {
  const { id } = useParams();
  const { user } = useSession();
  const query = useQuery({
    queryKey: ['vendor', id],
    queryFn: ({ signal }) => api<VendorDetailData>(`/vendors/${id}`, { signal }),
  });
  const v = query.data;
  if (query.isPending) return <Loading label="Loading vendor…" />;
  if (query.error || !v) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  const value = v.assets.reduce((s, a) => s + (a.purchaseCost ?? 0), 0);
  const email = firstEmail(v.email);
  const fact = (label: string, content: ReactNode) => (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-sm break-words text-gray-900">{content ?? '—'}</dd>
    </div>
  );

  return (
    <>
      <Link to="/vendors" className={backLinkClass}>
        ← Vendors
      </Link>
      <PageTitle
        eyebrow={`VENDOR · ${v.code}`}
        title={v.name}
        description={v.services ?? undefined}
        action={
          v.canManage ? (
            <Link to={`/vendors/${id}/edit`} className={buttonClass('secondary')}>
              Edit vendor
            </Link>
          ) : undefined
        }
      />
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Score" value={v.score == null ? 'Not rated' : `${v.score} / 10`} detail={v.status === 'ACTIVE' ? 'Active vendor' : 'Inactive'} />
        <StatTile label="Assets supplied" value={String(v.assets.length)} detail="Supplier matches this name" />
        {v.showsMoney ? <StatTile label="Value supplied" value={formatInr(value)} detail="Purchase cost" /> : null}
        {v.subscriptions ? <StatTile label="Subscriptions" value={String(v.subscriptions.length)} detail="Vendor matches this name" /> : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="flex flex-col gap-6 lg:col-span-3">
          <Panel title={`Assets supplied · ${v.assets.length}`}>
            {v.assets.length ? (
              <div className={tableWrapClass}>
                <table className={tableClass}>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Held by</th>
                      <th>Bought</th>
                      <th>Status</th>
                      {v.showsMoney ? <th className="text-right">Cost</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {v.assets.map((a) => (
                      <tr key={a.id}>
                        <td>
                          <Link to={`/assets/${a.id}`} className="block font-mono text-xs font-medium text-navy-700 no-underline hover:underline">
                            {a.assetCode}
                          </Link>
                          <span className="block max-w-56 truncate text-sm text-gray-800">{[a.manufacturer, a.model].filter(Boolean).join(' ') || a.description}</span>
                          <span className="text-xs text-gray-500">
                            {a.assetType || a.category}
                            {a.invoiceNumber ? ` · Invoice ${a.invoiceNumber}` : ''}
                          </span>
                        </td>
                        <td>
                          {a.holder ? (
                            <PersonChip userId={a.holder.userId} name={a.holder.name} hasPhoto={a.holder.hasPhoto} holdingsHref={`/people/${a.holder.userId}`} />
                          ) : (
                            <span className="text-gray-400">Not assigned</span>
                          )}
                        </td>
                        <td className="whitespace-nowrap text-sm">{a.purchaseDate ? displayDate(a.purchaseDate) : '—'}</td>
                        <td>
                          <Badge value={a.status} />
                        </td>
                        {v.showsMoney ? <td className="text-right tabular-nums">{a.purchaseCost != null ? formatInr(a.purchaseCost) : '—'}</td> : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-gray-500">
                No assets yet. Set an asset’s <strong className="font-medium">Supplier</strong> to “{v.name}” and it appears here.
              </p>
            )}
          </Panel>
          {v.subscriptions ? (
            <Panel title={`Subscriptions · ${v.subscriptions.length}`}>
              {v.subscriptions.length ? (
                <ul className="divide-y divide-gray-100">
                  {v.subscriptions.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <Link to={canViewSubscriptions(user) ? `/subscriptions/${s.id}` : '#'} className="min-w-0 flex-1 truncate font-medium text-gray-900 no-underline hover:text-navy-700">
                        {s.name}
                        {s.plan ? <span className="font-normal text-gray-500"> · {s.plan}</span> : null}
                      </Link>
                      <span className="text-xs text-gray-500">{s.renewalDate ? `Renews ${displayDate(s.renewalDate)}` : ''}</span>
                      <Badge value={s.status} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-gray-500">No subscriptions name this vendor.</p>
              )}
            </Panel>
          ) : null}
        </div>
        <div className="flex flex-col gap-6 lg:col-span-2">
          <Panel title="Contact">
            <dl className="grid grid-cols-1 gap-y-4">
              {fact('Contact person', v.contactPerson)}
              {fact(
                'Phone',
                v.phone ? (
                  <span className="flex flex-wrap gap-x-3">
                    {v.phone.split(/[\/,;\n]/).map((ph) => ph.trim()).filter(Boolean).map((ph) => (
                      <a key={ph} href={telHref(ph)} className="text-navy-700 tabular-nums">
                        {ph}
                      </a>
                    ))}
                  </span>
                ) : null,
              )}
              {fact('Email', email ? <a href={`mailto:${email}`} className="text-navy-700">{v.email}</a> : v.email)}
              {fact('Address', v.address)}
              {v.website
                ? fact(
                    'Website',
                    <a href={/^https?:\/\//i.test(v.website) ? v.website : `https://${v.website}`} target="_blank" rel="noreferrer noopener" className="text-navy-700">
                      {v.website}
                    </a>,
                  )
                : null}
              {v.gstin ? fact('GSTIN', <span className="font-mono">{v.gstin}</span>) : null}
            </dl>
          </Panel>
          <Panel title="Our reference people">
            {v.referencePeople.length ? (
              <ul className="flex flex-col gap-2">
                {v.referencePeople.map((p) => (
                  <li key={p.userId}>
                    <PersonChip userId={p.userId} name={p.name} hasPhoto={p.hasPhoto} detail={p.designation ?? undefined} designation={p.designation} holdingsHref={`/people/${p.userId}`} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-gray-500">Nobody named yet.</p>
            )}
          </Panel>
          {v.notes ? (
            <Panel title="Notes">
              <p className="text-sm whitespace-pre-wrap text-gray-700">{v.notes}</p>
            </Panel>
          ) : null}
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------- asset links */

/** An asset's supplier, linked to its vendor page when a vendor of that name exists. */
export function SupplierLink({ supplier }: { supplier: string | null | undefined }) {
  const { user } = useSession();
  const lookup = useQuery({
    queryKey: ['vendor-lookup', supplier?.trim().toLowerCase()],
    queryFn: ({ signal }) => api<{ vendor: { id: string; name: string } | null }>(`/vendors/lookup?name=${encodeURIComponent(supplier ?? '')}`, { signal }),
    enabled: !!supplier?.trim(),
    staleTime: 300_000,
  });
  if (!supplier?.trim()) return <>Unknown</>;
  const vendor = lookup.data?.vendor;
  return vendor && canViewVendors(user) ? (
    <Link to={`/vendors/${vendor.id}`} className="font-medium text-navy-700 no-underline hover:underline">
      {supplier}
    </Link>
  ) : (
    <>{supplier}</>
  );
}

/** Vendor names offered while typing a supplier (a browser suggestion list). */
export function VendorSuggestions({ id }: { id: string }) {
  const names = useQuery({
    queryKey: ['vendor-names'],
    queryFn: ({ signal }) => api<{ items: { id: string; name: string }[] }>('/vendors/names', { signal }),
    staleTime: 300_000,
  });
  return (
    <datalist id={id}>
      {(names.data?.items ?? []).map((v) => (
        <option key={v.id} value={v.name} />
      ))}
    </datalist>
  );
}
