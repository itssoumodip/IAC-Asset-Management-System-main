import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { usePages, useAction } from '../hooks';
import { hasRole, isStaff, useSession } from '../session';
import type { Asset, Page, Ticket, TimelineEvent, User } from '../types';
import { fetchAllPages } from '../transfer-files';
import { TICKET_LIMITS, preparePhoto } from '../photo-prepare';
import { BulkTransfer, ExportRecords, FormTransfer } from './DataTransfer';
import {
  useReferences,
  ReferenceSelect,
  ReferenceBadge,
  referenceLabel,
  referenceOptions,
} from './References';
import {
  Empty,
  ErrorNotice,
  Field,
  Loading,
  LoadMore,
  PageTitle,
  Panel,
  Timeline,
  displayDate,
  Select,
} from './ui';
const ticketExportColumns = [
  'ticketNumber',
  'subject',
  'description',
  'category',
  'priority',
  'status',
  'assetId',
  'ownerId',
  'createdAt',
  'updatedAt',
  'resolution',
];
function ticketExportRow(ticket: Ticket) {
  return Object.fromEntries(
    ticketExportColumns.map((key) => [key, ticket[key as keyof Ticket] ?? '']),
  );
}
export function TicketList() {
  const refs = useReferences();
  const { user } = useSession();
  const staff = isStaff(user);
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const priority = params.get('priority') ?? '';
  const category = params.get('category') ?? '';
  const search = params.get('q') ?? '';
  const ownership = staff ? (params.get('ownership') ?? 'ANY') : 'ANY';
  const filters = {
    status: status || undefined,
    priority: priority || undefined,
    category: category || undefined,
    q: search || undefined,
    ownership: ownership === 'ANY' ? undefined : ownership,
  };
  const query = usePages<Ticket>('/tickets', filters);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  function filter(name: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  }
  return (
    <>
      <PageTitle
        eyebrow={staff ? 'SUPPORT / TEAM QUEUE' : 'MY WORKSPACE / SUPPORT'}
        title={staff ? 'Support desk' : 'My support tickets'}
        description={
          staff
            ? 'Keep requests moving, share updates, and close the loop.'
            : 'Track your requests and stay in touch with the support team.'
        }
        action={
          <Link className="button" to="/tickets/new">
            Raise a ticket
          </Link>
        }
      />
      <ExportRecords
        name="tickets"
        columns={ticketExportColumns}
        load={async () =>
          (await fetchAllPages('/tickets', filters)).map((item) =>
            Object.fromEntries(ticketExportColumns.map((key) => [key, item[key] ?? ''])),
          )
        }
      />
      <BulkTransfer module="tickets" />
      <Panel>
        <div className="filter-bar ticket-triage-filters">
          <Field label="Status" htmlFor="ticket-status-filter">
            <ReferenceSelect
              refs={refs.data}
              kind="TICKET_STATUS"
              id="ticket-status-filter"
              value={status}
              onChange={(value) => filter('status', value)}
              required={false}
              allowEmpty
              includeInactive
            />
          </Field>
          <Field label="Priority" htmlFor="ticket-priority-filter">
            <ReferenceSelect
              refs={refs.data}
              kind="TICKET_PRIORITY"
              id="ticket-priority-filter"
              value={priority}
              onChange={(value) => filter('priority', value)}
              required={false}
              allowEmpty
              includeInactive
            />
          </Field>
          <Field label="Category" htmlFor="ticket-category-filter">
            <ReferenceSelect
              refs={refs.data}
              kind="TICKET_CATEGORY"
              id="ticket-category-filter"
              value={category}
              onChange={(v) => filter('category', v)}
              required={false}
              allowEmpty
              includeInactive
            />
          </Field>
          <Field label="Search subject or ticket number" htmlFor="ticket-search-filter">
            <input
              id="ticket-search-filter"
              value={search}
              onChange={(e) => filter('q', e.target.value)}
              maxLength={100}
              placeholder="Search support requests"
            />
          </Field>
          {staff ? (
            <Field label="Ownership" htmlFor="ticket-ownership-filter">
              <select
                id="ticket-ownership-filter"
                value={ownership}
                onChange={(e) => filter('ownership', e.target.value)}
              >
                <option value="ANY">Any owner</option>
                <option value="MINE">Assigned to me</option>
                <option value="UNASSIGNED">Unassigned</option>
              </select>
            </Field>
          ) : null}
          <p className="muted filter-hint">
            {staff
              ? 'Public replies notify the employee. Internal notes stay with your team.'
              : 'Your tickets remain available after equipment is returned.'}
          </p>
        </div>
        <ErrorNotice
          error={query.error}
          retry={() => {
            void query.refetch();
          }}
        />
        {query.isPending ? (
          <Loading label="Loading support requests..." />
        ) : items.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Ticket / subject</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Updated</th>
                  {staff ? <th>Ownership</th> : null}
                  <th>
                    <span className="sr-only">View</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>
                      <Link className="asset-code" to={`/tickets/${ticket.id}`}>
                        #{ticket.ticketNumber}
                      </Link>
                      <span className="cell-description">{ticket.subject}</span>
                    </td>
                    <td>
                      <ReferenceBadge refs={refs.data} kind="TICKET_STATUS" value={ticket.status} />
                    </td>
                    <td>
                      <ReferenceBadge
                        refs={refs.data}
                        kind="TICKET_PRIORITY"
                        value={ticket.priority}
                      />
                    </td>
                    <td>{displayDate(ticket.updatedAt ?? ticket.createdAt)}</td>
                    {staff ? <td>{ticket.ownerId ? 'Assigned' : 'Unassigned'}</td> : null}
                    <td>
                      <Link
                        to={`/tickets/${ticket.id}`}
                        className="table-link"
                        aria-label={`View ticket ${ticket.ticketNumber}`}
                      >
                        View →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !query.error ? (
          <Empty
            title="No tickets here"
            action={
              <Link className="button secondary" to="/tickets/new">
                Raise a ticket
              </Link>
            }
          >
            New requests and their updates will appear here. Try a different filter if needed.
          </Empty>
        ) : null}
        <LoadMore
          available={query.hasNextPage && !query.isPlaceholderData}
          loading={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        />
      </Panel>
    </>
  );
}
const MAX_PHOTOS = 3;
const PHOTO_PATTERN = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/;
function TicketPhotoPicker({
  photos,
  onChange,
  disabled,
}: {
  photos: string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
}) {
  const [errors, setErrors] = useState<string[]>([]);
  const [preparing, setPreparing] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const latest = useRef(photos);
  latest.current = photos;
  const full = photos.length >= MAX_PHOTOS;
  async function add(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    setErrors([]);
    if (!files.length) return;
    setPreparing(true);
    const failures: string[] = [];
    const added: string[] = [];
    for (const file of files) {
      if (latest.current.length + added.length >= MAX_PHOTOS) {
        failures.push(`${file.name}: You can attach up to ${MAX_PHOTOS} photos.`);
        continue;
      }
      try {
        added.push(await preparePhoto(file, TICKET_LIMITS));
      } catch (caught) {
        failures.push(
          `${file.name}: ${caught instanceof Error ? caught.message : 'Could not use this photo.'}`,
        );
      }
    }
    onChange([...latest.current, ...added]);
    setErrors(failures);
    setPreparing(false);
  }
  return (
    <fieldset className="photo-picker">
      <legend>Photos (optional)</legend>
      <p className="muted small-text">
        Up to {MAX_PHOTOS} photos of the problem. Photos are resized on your device and location
        data is removed.
      </p>
      <div className="actions">
        <button
          type="button"
          className="button secondary"
          disabled={disabled || full || preparing}
          onClick={() => camera.current?.click()}
        >
          Take photo
        </button>
        <button
          type="button"
          className="button secondary"
          disabled={disabled || full || preparing}
          onClick={() => gallery.current?.click()}
        >
          Choose photo
        </button>
      </div>
      <input
        ref={camera}
        type="file"
        accept="image/jpeg,image/png"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-label="Take photo"
        disabled={disabled || full || preparing}
        onChange={(event) => {
          void add(event);
        }}
      />
      <input
        ref={gallery}
        type="file"
        accept="image/jpeg,image/png"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose photo"
        disabled={disabled || full || preparing}
        onChange={(event) => {
          void add(event);
        }}
      />
      {preparing ? <Loading label="Preparing photo..." /> : null}
      {errors.map((message) => (
        <p key={message} className="notice danger" role="alert">
          {message}
        </p>
      ))}
      {photos.length ? (
        <ul className="photo-previews">
          {photos.map((photo, index) => (
            <li key={photo.slice(-40) + index}>
              <img src={photo} alt={`Attached photo ${index + 1}`} />
              <button
                type="button"
                className="button text small"
                disabled={disabled}
                onClick={() => onChange(photos.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </fieldset>
  );
}
export function TicketForm() {
  const refs = useReferences();
  const { user } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const assets = usePages<Asset>('/assets', {}, hasRole(user, 'EMPLOYEE'));
  const [assetId, setAssetId] = useState(params.get('assetId') ?? '');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('HARDWARE');
  const [priority, setPriority] = useState('MEDIUM');
  const [validation, setValidation] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const scannedCode = params.get('asset') && params.get('assetId') ? params.get('asset') : null;
  const action = useAction<Ticket>();
  const eligible =
    assets.data?.pages
      .flatMap((page) => page.items)
      .filter((asset) => asset.currentAssignment?.userId === user?.id) ?? [];
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!subject.trim() || !description.trim()) {
      setValidation('Please enter a subject and details.');
      return;
    }
    setValidation('');
    const result = await action
      .mutateAsync({
        path: '/tickets',
        body: {
          ...(assetId ? { assetId } : {}),
          subject: subject.trim(),
          description: description.trim(),
          category,
          priority,
          ...(photos.length ? { photos } : {}),
          ...(params.get('relatedTicketId')
            ? { relatedTicketId: params.get('relatedTicketId') }
            : {}),
        },
        idempotent: true,
      })
      .catch(() => undefined);
    if (result) navigate(`/tickets/${result.id}`, { state: { created: true } });
  }
  return (
    <>
      <Link className="back-link" to="/tickets">
        ← Support tickets
      </Link>
      <PageTitle
        title="How can we help?"
        description="Share the details with your support team. You will receive an email confirmation."
      />
      <div className="ticket-form-layout">
        <Panel title="New support request">
          <FormTransfer
            formId="ticket-create"
            fields={[
              { key: 'subject', required: true },
              { key: 'description', required: true },
              {
                key: 'category',
                required: true,
                options: referenceOptions(refs.data, 'TICKET_CATEGORY').map((item) => item.code),
              },
              {
                key: 'priority',
                required: true,
                options: referenceOptions(refs.data, 'TICKET_PRIORITY').map((item) => item.code),
              },
              {
                key: 'assetId',
                label: 'Related asset ID',
                options: eligible.map((item) => item.id),
              },
            ]}
            values={{ subject, description, category, priority, assetId }}
            disabled={action.isPending || refs.isPending || !!refs.error}
            description="Load one request for review. A linked asset must be one of your loaded current assignments. Submit ticket remains a separate action."
            onImport={(data) => {
              if (typeof data.subject === 'string') setSubject(data.subject);
              if (typeof data.description === 'string') setDescription(data.description);
              if (typeof data.category === 'string') setCategory(data.category);
              if (typeof data.priority === 'string') setPriority(data.priority);
              if (
                !scannedCode &&
                typeof data.assetId === 'string' &&
                (!data.assetId || eligible.some((item) => item.id === data.assetId))
              )
                setAssetId(data.assetId);
              setValidation('');
              action.reset();
            }}
          />
          <form className="form-stack" onSubmit={submit}>
            <ErrorNotice error={action.error} />
            <ErrorNotice
              error={refs.error}
              retry={() => {
                void refs.refetch();
              }}
            />
            {validation ? (
              <div role="alert" className="notice danger">
                {validation}
              </div>
            ) : null}
            {scannedCode ? (
              <Field label="Asset" htmlFor="ticket-scanned-asset">
                <input id="ticket-scanned-asset" value={scannedCode} readOnly />
              </Field>
            ) : (
              <>
                <Select
                  label="Related asset (optional)"
                  htmlFor="ticket-asset"
                  value={assetId}
                  onChange={setAssetId}
                  hint="Choose no asset for a portal access issue. Only currently assigned equipment is eligible."
                  options={[
                    { value: '', label: 'No asset / general support' },
                    ...(assetId && !eligible.some((asset) => asset.id === assetId)
                      ? [{ value: assetId, label: 'Loading selected asset...', disabled: true }]
                      : []),
                    ...eligible.map((asset) => ({
                      value: asset.id,
                      label: `${asset.assetCode} · ${asset.description}`,
                    })),
                  ]}
                />
                <ErrorNotice
                  error={assets.error}
                  retry={() => {
                    void assets.refetch();
                  }}
                />
                <LoadMore
                  available={assets.hasNextPage}
                  loading={assets.isFetchingNextPage}
                  onClick={() => {
                    void assets.fetchNextPage();
                  }}
                />
              </>
            )}
            <Field label="Subject" htmlFor="ticket-subject">
              <input
                id="ticket-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                maxLength={160}
                required
                placeholder="A short summary of the issue"
              />
            </Field>
            <div className="form-grid">
              <Field label="Category" htmlFor="ticket-category">
                <ReferenceSelect
                  refs={refs.data}
                  kind="TICKET_CATEGORY"
                  id="ticket-category"
                  value={category}
                  onChange={setCategory}
                  preserveCurrent={false}
                />
              </Field>
              <Field label="Priority" htmlFor="ticket-priority">
                <ReferenceSelect
                  refs={refs.data}
                  kind="TICKET_PRIORITY"
                  id="ticket-priority"
                  value={priority}
                  onChange={setPriority}
                  preserveCurrent={false}
                />
              </Field>
            </div>
            <Field
              label="What happened?"
              htmlFor="ticket-description"
              hint={`${description.length}/5000 characters. Include symptoms, when it began, and steps you have tried.`}
            >
              <textarea
                id="ticket-description"
                rows={7}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={5000}
                required
              />
            </Field>
            <TicketPhotoPicker photos={photos} onChange={setPhotos} disabled={action.isPending} />
            <div className="form-actions">
              <Link className="button secondary" to="/tickets">
                Cancel
              </Link>
              <button
                className="button"
                disabled={
                  action.isPending ||
                  refs.isPending ||
                  !!refs.error ||
                  !referenceOptions(refs.data, 'TICKET_CATEGORY').some(
                    (item) => item.code === category,
                  ) ||
                  !referenceOptions(refs.data, 'TICKET_PRIORITY').some(
                    (item) => item.code === priority,
                  )
                }
              >
                {action.isPending ? 'Submitting...' : 'Submit ticket →'}
              </button>
            </div>
          </form>
        </Panel>
        <aside className="help-card">
          <h2>Help us help you.</h2>
          <p>Describe the issue clearly and add any useful error message.</p>
          <ul>
            <li>Choose the affected equipment.</li>
            <li>Tell us what you expected to happen.</li>
            <li>Share what you already tried.</li>
          </ul>
          <hr />
          <p className="small-text">
            Keep passwords, clinical records, and unnecessary personal information out of your
            request.
          </p>
          <p className="small-text">
            Your request is saved before email delivery. Notification delays do not erase your
            ticket.
          </p>
        </aside>
      </div>
    </>
  );
}
function TicketPhotoThumb({
  ticketId,
  n,
  onOpen,
}: {
  ticketId: string;
  n: number;
  onOpen: (photo: string) => void;
}) {
  const query = useQuery({
    queryKey: ['ticket-photo', ticketId, n],
    queryFn: ({ signal }) =>
      api<{ dataUrl: string | null }>(`/tickets/${ticketId}/photos/${n}`, { signal }),
    staleTime: 5 * 60 * 1000,
  });
  const photo = query.data?.dataUrl;
  if (query.isPending) return <li className="photo-thumb-pending">Loading photo {n}...</li>;
  if (!photo || !PHOTO_PATTERN.test(photo))
    return <li className="photo-thumb-pending">Photo {n} is unavailable.</li>;
  return (
    <li>
      <button
        type="button"
        className="photo-thumb"
        aria-label={`View photo ${n} full size`}
        onClick={() => onOpen(photo)}
      >
        <img src={photo} alt={`Ticket photo ${n}`} loading="lazy" />
      </button>
    </li>
  );
}
function TicketPhotos({ ticketId, count }: { ticketId: string; count: number }) {
  const [open, setOpen] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <div className="ticket-photos">
      <h3>Photos ({count})</h3>
      <ul className="photo-previews">
        {Array.from({ length: Math.min(count, MAX_PHOTOS) }, (_, index) => (
          <TicketPhotoThumb key={index} ticketId={ticketId} n={index + 1} onOpen={setOpen} />
        ))}
      </ul>
      <dialog ref={dialog} className="photo-dialog" onClose={() => setOpen(undefined)}>
        {open ? <img src={open} alt="Ticket photo, full size" /> : null}
        <button type="button" className="button secondary" onClick={() => setOpen(undefined)}>
          Close
        </button>
      </dialog>
    </div>
  );
}
export function TicketDetail() {
  const refs = useReferences();
  const { id } = useParams();
  const { user } = useSession();
  const staff = isStaff(user);
  const query = useQuery({
    queryKey: ['ticket', id],
    queryFn: ({ signal }) => api<Ticket>(`/tickets/${id}`, { signal }),
  });
  const assetQuery = useQuery({
    queryKey: ['asset', query.data?.assetId],
    queryFn: ({ signal }) => api<Asset>(`/assets/${query.data?.assetId}`, { signal }),
    enabled: !!query.data?.assetId,
  });
  const history = usePages<TimelineEvent>(`/tickets/${id}/updates`);
  const staffUsers = useQuery({
    queryKey: ['staff-users'],
    queryFn: () => api<Page<User>>('/users?limit=100'),
    enabled: hasRole(user, 'ADMIN'),
  });
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState('PUBLIC');
  const [resolution, setResolution] = useState('');
  const [completing, setCompleting] = useState(false);
  const [statusVersion, setStatusVersion] = useState<number>();
  const [ownerVersion, setOwnerVersion] = useState<number>();
  const [ownerId, setOwnerId] = useState('');
  const action = useAction();
  const [draftVersion, setDraftVersion] = useState<number>();
  if (query.isPending) return <Loading label="Loading conversation..." />;
  if (query.error)
    return (
      <ErrorNotice
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  const ticket = query.data;
  if (!ticket) return <Empty title="Ticket unavailable" />;
  const assignedOwner = staffUsers.data?.items.find((item) => item.id === ticket.ownerId);
  const updates = history.data?.pages.flatMap((page) => page.items) ?? ticket.updates ?? [];
  async function reply(event: FormEvent) {
    event.preventDefault();
    if (!body.trim()) return;
    await action
      .mutateAsync({
        path: `/tickets/${id}/updates`,
        body: { body: body.trim(), visibility: staff ? visibility : 'PUBLIC' },
        version: draftVersion ?? ticket?.version,
      })
      .then(() => {
        setBody('');
        setDraftVersion(undefined);
      })
      .catch(() => undefined);
  }
  async function status(next: string) {
    await action
      .mutateAsync({
        path: `/tickets/${id}/status`,
        method: 'PATCH',
        body: { status: next, ...(next === 'COMPLETED' ? { resolution: resolution.trim() } : {}) },
        version: statusVersion ?? ticket?.version,
      })
      .then(() => {
        setCompleting(false);
        setResolution('');
        setStatusVersion(undefined);
      })
      .catch(() => undefined);
  }
  async function owner(value: string) {
    await action
      .mutateAsync({
        path: `/tickets/${id}/owner`,
        method: 'PATCH',
        body: { ownerId: value },
        version: ownerVersion ?? ticket?.version,
      })
      .then(() => setOwnerVersion(undefined))
      .catch(() => undefined);
  }
  return (
    <>
      <Link className="back-link" to="/tickets">
        ← Support desk
      </Link>
      <PageTitle
        eyebrow={`SUPPORT / #${ticket.ticketNumber}`}
        title={ticket.subject}
        description={`Opened ${displayDate(ticket.createdAt, true)} · ${referenceLabel(refs.data, 'TICKET_CATEGORY', ticket.category)}`}
        action={
          ticket.status === 'COMPLETED' ? (
            <Link to={`/tickets/new?relatedTicketId=${ticket.id}`} className="button secondary">
              Create follow-up ticket
            </Link>
          ) : undefined
        }
      />
      <ExportRecords
        name={`ticket-${ticket.ticketNumber}`}
        columns={[
          ...ticketExportColumns,
          'updateKind',
          'updateVisibility',
          'updateBody',
          'updateCreatedAt',
        ]}
        load={async () => {
          const [current, updates] = await Promise.all([
            api<Ticket>(`/tickets/${ticket.id}`),
            fetchAllPages(`/tickets/${ticket.id}/updates`),
          ]);
          const rows = updates.filter((item) => staff || item.visibility === 'PUBLIC');
          const details = ticketExportRow(current);
          return rows.length
            ? rows.map((item) => ({
                ...details,
                updateKind: item.kind ?? '',
                updateVisibility: item.visibility ?? '',
                updateBody: item.body ?? '',
                updateCreatedAt: item.createdAt ?? '',
              }))
            : [details];
        }}
      />
      <ErrorNotice
        error={action.error}
        retry={() => {
          action.reset();
          void Promise.all([query.refetch(), history.refetch()]).then(() => {
            setDraftVersion(undefined);
            setStatusVersion(undefined);
            setOwnerVersion(undefined);
          });
        }}
      />
      <div className="ticket-detail-layout">
        <div className="stack">
          <Panel title="Conversation">
            <div className="ticket-description preserve">{ticket.description}</div>
            {ticket.photoCount ? (
              <TicketPhotos ticketId={ticket.id} count={ticket.photoCount} />
            ) : null}
            <ErrorNotice
              error={history.error}
              retry={() => {
                void history.refetch();
              }}
            />
            {history.isPending ? (
              <Loading label="Loading updates..." />
            ) : (
              <Timeline items={updates} />
            )}
            <LoadMore
              available={history.hasNextPage}
              loading={history.isFetchingNextPage}
              onClick={() => {
                void history.fetchNextPage();
              }}
            />
          </Panel>
          {ticket.status !== 'COMPLETED' ? (
            <Panel title="Add an update">
              <form className="form-stack" onSubmit={reply}>
                <Field
                  label={visibility === 'INTERNAL' ? 'Internal note' : 'Reply'}
                  htmlFor="reply-body"
                >
                  <textarea
                    id="reply-body"
                    value={body}
                    onChange={(event) => {
                      if (!body) setDraftVersion(ticket.version);
                      setBody(event.target.value);
                    }}
                    maxLength={5000}
                    rows={5}
                    required
                  />
                </Field>
                {staff ? (
                  <Select
                    label="Visibility"
                    htmlFor="reply-visibility"
                    value={visibility}
                    onChange={setVisibility}
                    options={[
                      { value: 'PUBLIC', label: 'Public reply · employee is notified' },
                      { value: 'INTERNAL', label: 'Internal note · staff only' },
                    ]}
                  />
                ) : null}
                <button className="button" disabled={action.isPending || !body.trim()}>
                  {action.isPending
                    ? 'Saving...'
                    : visibility === 'INTERNAL'
                      ? 'Save internal note'
                      : 'Send reply'}
                </button>
              </form>
            </Panel>
          ) : (
            <div className="notice success">
              <strong>Completed</strong>
              <p className="preserve">
                {ticket.resolution ||
                  'This request is completed. Create a follow-up ticket if you need further help.'}
              </p>
            </div>
          )}
        </div>
        <aside className="stack">
          <Panel title="Ticket details">
            <dl className="details">
              <dt>Status</dt>
              <dd>
                <ReferenceBadge refs={refs.data} kind="TICKET_STATUS" value={ticket.status} />
              </dd>
              <dt>Priority</dt>
              <dd>
                <ReferenceBadge refs={refs.data} kind="TICKET_PRIORITY" value={ticket.priority} />
              </dd>
              <dt>Owner</dt>
              <dd>
                {ticket.ownerId === user?.id
                  ? 'You'
                  : ticket.ownerId
                    ? assignedOwner
                      ? `${assignedOwner.displayName} · ${assignedOwner.email}`
                      : 'Assigned staff member'
                    : 'Unassigned'}
              </dd>
              <dt>Asset</dt>
              <dd>
                {ticket.assetId && assetQuery.data ? (
                  hasRole(user, 'ADMIN') ||
                  hasRole(user, 'IT_ADMIN') ||
                  assetQuery.data.currentAssignment?.userId === user?.id ? (
                    <Link to={`/assets/${ticket.assetId}`}>View linked asset →</Link>
                  ) : (
                    'Asset linked (restricted)'
                  )
                ) : ticket.assetId ? (
                  <Link to={`/assets/${ticket.assetId}`}>View linked asset →</Link>
                ) : (
                  'No asset'
                )}
              </dd>
            </dl>
            {staff && ticket.status !== 'COMPLETED' ? (
              <div className="subsection form-stack">
                {ticket.ownerId !== user?.id ? (
                  <button
                    type="button"
                    className="button secondary"
                    disabled={action.isPending}
                    onClick={() => {
                      void owner(user!.id);
                    }}
                  >
                    Take ownership
                  </button>
                ) : null}
                {hasRole(user, 'ADMIN') ? (
                  <>
                    <Select
                      label="Assign to staff"
                      htmlFor="ticket-owner"
                      value={ownerId}
                      onChange={(value) => {
                        setOwnerId(value);
                        setOwnerVersion(ticket.version);
                      }}
                      options={[
                        { value: '', label: 'Select team member' },
                        ...(staffUsers.data?.items
                          .filter(
                            (item) =>
                              item.state === 'ACTIVE' &&
                              (item.roles.includes('ADMIN') || item.roles.includes('IT_ADMIN')),
                          )
                          .map((item) => ({
                            value: item.id,
                            label: item.displayName,
                          })) || []),
                      ]}
                    />
                    <button
                      className="button secondary"
                      type="button"
                      disabled={!ownerId || action.isPending}
                      onClick={() => {
                        void owner(ownerId);
                      }}
                    >
                      Update owner
                    </button>
                  </>
                ) : null}
                {ticket.status === 'OPEN' ? (
                  <button
                    className="button secondary"
                    type="button"
                    disabled={action.isPending}
                    onClick={() => {
                      void status('IN_PROGRESS');
                    }}
                  >
                    Start progress
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button"
                  disabled={action.isPending}
                  onClick={() => {
                    setCompleting(!completing);
                    setStatusVersion(ticket.version);
                  }}
                >
                  Mark completed
                </button>
                {completing ? (
                  <form
                    className="form-stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void status('COMPLETED');
                    }}
                  >
                    <Field
                      label="Resolution"
                      htmlFor="resolution"
                      hint="The employee receives this resolution."
                    >
                      <textarea
                        id="resolution"
                        value={resolution}
                        onChange={(event) => setResolution(event.target.value)}
                        maxLength={5000}
                        required
                      />
                    </Field>
                    <button className="button" disabled={action.isPending || !resolution.trim()}>
                      Confirm completion
                    </button>
                  </form>
                ) : null}
              </div>
            ) : null}
          </Panel>
          <div className="help-card">
            <h3>Keep the loop closed</h3>
            <p>
              Public replies and completion updates notify the employee. Internal notes stay visible
              to authorized staff.
            </p>
            <p className="small-text">
              Ticket completion does not change asset custody or inventory status.
            </p>
          </div>
        </aside>
      </div>
    </>
  );
}
