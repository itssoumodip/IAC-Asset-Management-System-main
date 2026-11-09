import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAction } from '../hooks';
import { Empty, ErrorNotice, Loading, PageTitle, Panel, buttonClass } from './ui';

interface Announcement {
  id: string;
  title: string;
  message: string;
  path: '/dashboard' | '/assets' | '/tickets' | '/notifications';
  audience: 'ALL' | 'ADMIN' | 'DEPARTMENT' | 'FINANCE';
  departmentName: string | null;
  createdAt: string;
  read: boolean;
  attachment: { name: string; type: 'image/jpeg' | 'application/pdf'; size: number } | null;
}

interface Inbox {
  items: Announcement[];
  total: number;
  unreadCount: number;
}

export function useNotificationInbox() {
  return useQuery({
    queryKey: ['notification-inbox'],
    queryFn: () => api<Inbox>('/notifications'),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useUnreadNotificationCount() {
  return useQuery({
    queryKey: ['notification-unread-count'],
    queryFn: () => api<{ unreadCount: number }>('/notifications/unread-count'),
    staleTime: 15_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

export function NotificationsPage() {
  const inbox = useNotificationInbox();
  const action = useAction<{ read: boolean }>();
  const [filter, setFilter] = useState<'ALL' | 'UNREAD'>('ALL');
  const visibleItems = inbox.data?.items.filter((item) => filter === 'ALL' || !item.read) ?? [];

  return (
    <>
      <PageTitle
        title="Notifications"
        description="Notices from your IT team, shared with your account or department."
        action={
          inbox.data?.unreadCount ? (
            <button
              type="button"
              className={buttonClass('secondary')}
              disabled={action.isPending}
              onClick={() =>
                action.mutate({ path: '/notifications/read-all', method: 'POST', body: {} })
              }
            >
              Mark all as read
            </button>
          ) : undefined
        }
      />
      <ErrorNotice error={inbox.error} retry={() => void inbox.refetch()} />
      <ErrorNotice error={action.error} />
      {inbox.isPending ? <Loading label="Loading notifications…" /> : null}
      {inbox.data && inbox.data.items.length === 0 ? (
        <Panel className="notification-empty-panel">
          <Empty title="No announcements yet">
            New messages from your IT team will appear here.
          </Empty>
        </Panel>
      ) : null}
      {inbox.data?.items.length ? (
        <section className="notification-inbox" aria-label="Announcements">
          <div className="notification-inbox-heading">
            <div>
              <span className="eyebrow">YOUR INBOX</span>
              <p className="notification-summary">
                {inbox.data.unreadCount
                  ? `${inbox.data.unreadCount} unread`
                  : 'You’re all caught up'}
              </p>
            </div>
            <span className="muted">
              {inbox.data.total} {inbox.data.total === 1 ? 'notice' : 'notices'}
            </span>
          </div>
          <div className="notification-filters" role="group" aria-label="Filter notifications">
            <button
              type="button"
              className={`notification-filter${filter === 'ALL' ? ' is-selected' : ''}`}
              aria-pressed={filter === 'ALL'}
              onClick={() => setFilter('ALL')}
            >
              All <span>{inbox.data.total}</span>
            </button>
            <button
              type="button"
              className={`notification-filter${filter === 'UNREAD' ? ' is-selected' : ''}`}
              aria-pressed={filter === 'UNREAD'}
              onClick={() => setFilter('UNREAD')}
            >
              Unread <span>{inbox.data.unreadCount}</span>
            </button>
          </div>
          {visibleItems.length === 0 ? (
            <p className="notification-filter-empty">You have no unread notices.</p>
          ) : null}
          {visibleItems.map((item) => (
            <article
              id={`notice-${item.id}`}
              key={item.id}
              className={`notification-card${item.read ? '' : ' is-unread'}`}
              tabIndex={-1}
            >
              <div className="notification-card-heading">
                <span className="notification-status" aria-label={item.read ? 'Read' : 'Unread'} />
                <h2>{item.title}</h2>
                <span className="notification-audience">
                  {item.audience === 'ADMIN'
                    ? 'Admins'
                    : item.audience === 'FINANCE'
                      ? 'Finance'
                      : item.audience === 'DEPARTMENT'
                        ? item.departmentName
                        : 'All staff'}
                </span>
              </div>
              <p className="notification-message">{item.message}</p>
              {item.attachment?.type === 'image/jpeg' ? (
                <a
                  className="notification-attachment-image"
                  href={`/api/v1/notifications/${item.id}/attachment`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <img
                    src={`/api/v1/notifications/${item.id}/attachment`}
                    alt={item.attachment.name}
                    loading="lazy"
                  />
                  <span>{item.attachment.name}</span>
                </a>
              ) : null}
              {item.attachment?.type === 'application/pdf' ? (
                <a
                  className="notification-attachment-file"
                  href={`/api/v1/notifications/${item.id}/attachment`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span aria-hidden="true">PDF</span>
                  <span>{item.attachment.name}</span>
                  <span className="muted">Open attachment ↗</span>
                </a>
              ) : null}
              <div className="notification-card-footer">
                <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
                <div className="notification-actions">
                  {!item.read ? (
                    <button
                      type="button"
                      className={buttonClass('ghost', 'sm')}
                      disabled={action.isPending}
                      onClick={() =>
                        action.mutate({
                          path: `/notifications/${item.id}/read`,
                          method: 'POST',
                          body: {},
                        })
                      }
                    >
                      Mark as read
                    </button>
                  ) : null}
                  {item.path !== '/notifications' ? (
                    <Link
                      className={buttonClass('secondary', 'sm')}
                      to={item.path}
                      aria-label={`Open ${item.title}`}
                    >
                      Open
                    </Link>
                  ) : null}
                </div>
              </div>
            </article>
          ))}
          {filter === 'ALL' && inbox.data.total > inbox.data.items.length ? (
            <p className="muted">Showing the latest {inbox.data.items.length} announcements.</p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
