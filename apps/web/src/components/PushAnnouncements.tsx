import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useAction } from '../hooks';
import { useReferences } from './References';
import {
  Checkbox,
  ErrorNotice,
  Field,
  PageTitle,
  Panel,
  Select,
  noticeClass,
  buttonClass,
  cx,
} from './ui';

type Audience = 'ALL' | 'ADMIN' | 'DEPARTMENT';
type Attachment = { name: string; type: 'image/jpeg' | 'application/pdf'; dataUrl: string };
type AnnouncementResult = {
  announcementId: string;
  inAppRecipients: number;
  pushConfigured: boolean;
  subscribedDevices: number;
  sent: number;
  failed: number;
  failureStatuses: { statusCode: number | null; count: number }[];
  audience: Audience;
  departmentName: string | null;
};
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const IMAGE_LIMITS = { maxBytes: 2 * 1024 * 1024, maxEdge: 1800 };

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read this file. Try another one.'));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error('Could not read this file. Try another one.'));
    reader.readAsDataURL(file);
  });
}

function safeFileName(name: string, extension: string) {
  const stem =
    name
      .replace(/\.[^.]*$/, '')
      .replace(/[^\w .()-]/g, '_')
      .trim() || 'attachment';
  return `${stem.slice(0, 110)}.${extension}`;
}

export function PushAnnouncements() {
  const references = useReferences();
  const config = useQuery({
    queryKey: ['push-config'],
    queryFn: () => api<{ enabled: boolean; publicKey: string | null }>('/push/public-key'),
    staleTime: 60_000,
    refetchOnWindowFocus: 'always',
  });
  const action = useAction<AnnouncementResult>();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [path, setPath] = useState('/dashboard');
  const [audience, setAudience] = useState<Audience>('ALL');
  const [departmentId, setDepartmentId] = useState('');
  const [attachment, setAttachment] = useState<Attachment>();
  const [attachmentError, setAttachmentError] = useState('');
  const [preparingAttachment, setPreparingAttachment] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [result, setResult] = useState<AnnouncementResult>();

  const departments = [...(references.data?.departments ?? [])]
    .filter((department) => department.active)
    .sort((left, right) => left.name.localeCompare(right.name));
  const audienceLabel = (scope: Audience, departmentName?: string | null) =>
    scope === 'ADMIN'
      ? 'Admins only'
      : scope === 'DEPARTMENT'
        ? departmentName || 'Department'
        : 'All active users';

  async function chooseAttachment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setAttachmentError('');
    setPreparingAttachment(true);
    try {
      if (file.type === 'application/pdf') {
        if (!file.size || file.size > MAX_PDF_BYTES)
          throw new Error('PDFs must be 4 MiB or smaller.');
        setAttachment({
          name: safeFileName(file.name, 'pdf'),
          type: 'application/pdf',
          dataUrl: await readDataUrl(file),
        });
      } else if (file.type === 'image/jpeg' || file.type === 'image/png') {
        const { preparePhoto } = await import('../photo-prepare');
        setAttachment({
          name: safeFileName(file.name, 'jpg'),
          type: 'image/jpeg',
          dataUrl: await preparePhoto(file, IMAGE_LIMITS),
        });
      } else {
        throw new Error('Choose a JPEG, PNG, or PDF file.');
      }
    } catch (cause) {
      setAttachment(undefined);
      setAttachmentError(
        cause instanceof Error ? cause.message : 'Could not prepare this attachment.',
      );
    } finally {
      setPreparingAttachment(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setResult(undefined);
    try {
      const response = await action.mutateAsync({
        path: '/push/broadcast',
        body: {
          title,
          message,
          path,
          audience,
          ...(audience === 'DEPARTMENT' ? { departmentId } : {}),
          ...(attachment ? { attachment } : {}),
        },
      });
      setResult(response);
      setTitle('');
      setMessage('');
      setAttachment(undefined);
      setAttachmentError('');
      setConfirmed(false);
    } catch {
      // The mutation error is shown below.
    }
  }

  return (
    <>
      <PageTitle
        title="Announcements"
        description="Publish a staff notice with a clear audience. It appears in each recipient’s notification inbox; browser push is optional."
      />
      {config.isError ? (
        <div className={noticeClass('warning')}>
          Push status could not be checked. Announcements will still appear in users’ inboxes.
        </div>
      ) : null}
      <ErrorNotice error={action.error} />
      <div className="announcement-layout">
        <Panel title="Compose notice" className="announcement-compose">
          {!config.isPending && !config.error && !config.data?.enabled ? (
            <p className="announcement-push-status">
              Browser push is off. The notice will still appear in the selected users’ inboxes.
            </p>
          ) : config.data?.enabled ? (
            <p className="announcement-push-status">
              Browser push is ready for recipients who enabled it.
            </p>
          ) : null}
          <form className="form-stack announcement-form" onSubmit={(event) => void submit(event)}>
            <Field label="Title" htmlFor="push-title" hint={`${title.length}/100`}>
              <input
                id="push-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={100}
                required
              />
            </Field>
            <Field label="Message" htmlFor="push-message" hint={`${message.length}/500`}>
              <textarea
                id="push-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={500}
                rows={5}
                required
              />
            </Field>
            <div className="announcement-scope-grid">
              <Select
                label="Access level"
                htmlFor="announcement-audience"
                value={audience}
                onChange={(value) => {
                  setAudience(value as Audience);
                  if (value !== 'DEPARTMENT') setDepartmentId('');
                  setConfirmed(false);
                }}
                options={[
                  { value: 'ALL', label: 'All active users' },
                  { value: 'ADMIN', label: 'Admins only' },
                  { value: 'DEPARTMENT', label: 'One department' },
                ]}
              />
              {audience === 'DEPARTMENT' ? (
                <Select
                  label="Department"
                  htmlFor="announcement-department"
                  value={departmentId}
                  onChange={(value) => {
                    setDepartmentId(value);
                    setConfirmed(false);
                  }}
                  disabled={references.isPending || !departments.length}
                  required
                  options={[
                    {
                      value: '',
                      label: references.isPending ? 'Loading departments…' : 'Choose department',
                    },
                    ...departments.map((department) => ({
                      value: department.id,
                      label: department.name,
                    })),
                  ]}
                />
              ) : null}
            </div>
            <Field
              label="Attachment"
              htmlFor="announcement-attachment"
              hint="JPEG, PNG, or PDF · images are cleaned before upload · PDF limit 4 MiB"
            >
              <input
                id="announcement-attachment"
                className="announcement-file-input"
                type="file"
                accept="image/jpeg,image/png,application/pdf"
                onChange={(event) => void chooseAttachment(event)}
                disabled={preparingAttachment || action.isPending}
              />
            </Field>
            {preparingAttachment ? <p className="muted">Preparing attachment…</p> : null}
            {attachmentError ? (
              <p className="announcement-file-error" role="alert">
                {attachmentError}
              </p>
            ) : null}
            {attachment ? (
              <div className="announcement-file-selected">
                <span>
                  {attachment.name}{' '}
                  <small>{attachment.type === 'application/pdf' ? 'PDF' : 'Image'}</small>
                </span>
                <button
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  onClick={() => setAttachment(undefined)}
                >
                  Remove
                </button>
              </div>
            ) : null}
            <Select
              label="Open when tapped"
              htmlFor="push-path"
              value={path}
              onChange={setPath}
              options={[
                { value: '/dashboard', label: 'Overview' },
                { value: '/assets', label: 'Asset catalog' },
                { value: '/tickets', label: 'Support desk' },
              ]}
            />
            <Checkbox
              checked={confirmed}
              onChange={setConfirmed}
              label={`I reviewed this notice. It will be visible to ${audienceLabel(audience, departments.find((item) => item.id === departmentId)?.name)}.`}
            />
            <button
              className={cx(buttonClass(), 'announcement-publish')}
              type="submit"
              disabled={
                !confirmed ||
                action.isPending ||
                preparingAttachment ||
                (audience === 'DEPARTMENT' && !departmentId)
              }
            >
              {action.isPending ? 'Publishing…' : 'Publish announcement'}
            </button>
          </form>
        </Panel>
        <aside className="announcement-preview-column">
          <div className="announcement-preview-label">Recipient preview</div>
          <article className="announcement-preview" aria-live="polite">
            <div className="announcement-preview-meta">
              <span>
                {audienceLabel(
                  audience,
                  departments.find((item) => item.id === departmentId)?.name,
                )}
              </span>
              <span>Announcement</span>
            </div>
            <h2>{title || 'Your announcement title'}</h2>
            <p>{message || 'Your message will appear here for the selected audience.'}</p>
            {attachment?.type === 'image/jpeg' ? (
              <img src={attachment.dataUrl} alt="Attachment preview" />
            ) : null}
            {attachment?.type === 'application/pdf' ? (
              <p className="announcement-preview-file">PDF · {attachment.name}</p>
            ) : null}
          </article>
          <p className="announcement-preview-note">
            Recipients can read this notice in the portal. If push is available, subscribed devices
            receive a short alert too.
          </p>
        </aside>
      </div>
      {result ? (
        <div
          className={result.pushConfigured && result.failed ? 'notice warning' : 'notice success'}
          role="status"
        >
          <strong>
            Announcement published to {audienceLabel(result.audience, result.departmentName)}.
          </strong>
          <p>It is now in the inbox for {result.inAppRecipients} active users in that audience.</p>
          {result.pushConfigured ? (
            <p>
              Browser push accepted {result.sent} of {result.subscribedDevices} subscribed devices
              {result.failed ? `; ${result.failed} failed` : ''}.
            </p>
          ) : (
            <p>
              Browser push is not configured, so no device alerts were sent. The in-app announcement
              is available to {audienceLabel(result.audience, result.departmentName)} in their
              inbox.
            </p>
          )}
          {result.failureStatuses.length ? (
            <p>
              Push provider status:{' '}
              {result.failureStatuses
                .map(
                  ({ statusCode, count }) =>
                    `${statusCode === null ? 'network error' : `HTTP ${statusCode}`} (${count})`,
                )
                .join(', ')}
              .
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
