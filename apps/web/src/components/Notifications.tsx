import { useState } from 'react';
import { useQuery, useInfiniteQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, queryString } from '../api';
import { useAction } from '../hooks';
import { Empty, ErrorNotice, Loading, PageTitle, Panel } from './ui';

interface Announcement {
  id: string;
  title: string;
  message: string;
  path: string;
  audience: 'ALL' | 'ADMIN' | 'DEPARTMENT';
  departmentName: string | null;
  createdAt: string;
  read: boolean;
  attachment: { name: string; type: 'image/jpeg' | 'application/pdf'; size: number } | null;
}

interface Inbox {
  items: Announcement[];
  total: number;
  unreadCount: number;
  nextCursor: string | null;
}

export function useNotificationInbox(filter: 'ALL' | 'UNREAD' = 'ALL') {
  return useInfiniteQuery({
    queryKey: ['notification-inbox', filter],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<Inbox>('/notifications' + queryString({ filter, cursor: pageParam || undefined }), {
        signal,
      }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
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
  const [filter, setFilter] = useState<'ALL' | 'UNREAD'>('ALL');
  const inbox = useNotificationInbox(filter);
  const workflow = useInfiniteQuery({
    queryKey: ['workflow-notifications', filter],
    initialPageParam: '',
    queryFn: ({ pageParam, signal }) =>
      api<Inbox>(
        '/notifications/workflow' + queryString({ filter, cursor: pageParam || undefined }),
        { signal },
      ),
    getNextPageParam: (p) => p.nextCursor ?? undefined,
    refetchInterval: 60000,
    refetchOnWindowFocus: true,
  });
  const action = useAction<{ read: boolean }>();
  const visibleItems = inbox.data?.pages.flatMap((page) => page.items) ?? [];
  const counts = inbox.data?.pages[0];

  return (
    <>
      <PageTitle
        title="Notifications"
        description="Workflow updates for your account and notices from your IT team. Email delivery is tracked separately."
        action={
          counts?.unreadCount ? (
            <button
              type="button"
              className="button secondary"
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
      <Panel title="Workflow updates">
        <div role="group" aria-label="Filter workflow notifications">
          <button
            type="button"
            className="button secondary small"
            aria-pressed={filter === 'ALL'}
            onClick={() => setFilter('ALL')}
          >
            All workflow updates
          </button>
          <button
            type="button"
            className="button secondary small"
            aria-pressed={filter === 'UNREAD'}
            onClick={() => setFilter('UNREAD')}
          >
            Unread workflow updates
          </button>
        </div>
        <ErrorNotice error={workflow.error} retry={() => void workflow.refetch()} />
        {workflow.isPending ? <Loading /> : null}
        <p>
          {workflow.data?.pages[0]?.unreadCount ?? 0} unread workflow updates. In-app updates do not
          depend on successful email delivery.
        </p>
        {workflow.data?.pages[0]?.unreadCount ? (
          <button
            type="button"
            className="button secondary small"
            disabled={action.isPending}
            onClick={() =>
              action.mutate({ path: '/notifications/workflow/read-all', method: 'POST', body: {} })
            }
          >
            Mark all workflow updates as read
          </button>
        ) : null}
        {workflow.data?.pages
          .flatMap((p) => p.items)
          .map((item) => (
            <article className="notification-card" key={item.id}>
              <h2>{item.title}</h2>
              <p>{item.message}</p>
              <p className="muted">
                {new Date(item.createdAt).toLocaleString()} · {item.read ? 'Read' : 'Unread'}
              </p>
              <div className="notification-actions">
                {!item.read ? (
                  <button
                    type="button"
                    className="button text small"
                    disabled={action.isPending}
                    onClick={() =>
                      action.mutate({
                        path: `/notifications/workflow/${item.id}/read`,
                        method: 'POST',
                        body: {},
                      })
                    }
                  >
                    Mark workflow as read
                  </button>
                ) : null}
                <Link className="button secondary small" to={item.path}>
                  Open workflow
                </Link>
              </div>
            </article>
          ))}
        {workflow.data?.pages[0]?.total === 0 ? (
          <p>No workflow updates visible for your current access.</p>
        ) : null}
        {workflow.hasNextPage ? (
          <button
            className="button secondary"
            disabled={workflow.isFetchingNextPage}
            onClick={() => void workflow.fetchNextPage()}
          >
            Load more workflow updates
          </button>
        ) : null}
      </Panel>
      <ErrorNotice error={inbox.error} retry={() => void inbox.refetch()} />
      <ErrorNotice error={action.error} />
      {inbox.isPending ? <Loading label="Loading notifications…" /> : null}
      {counts && counts.total === 0 ? (
        <Panel className="notification-empty-panel">
          <Empty title="No team announcements yet">
            New messages from your IT team will appear here.
          </Empty>
        </Panel>
      ) : null}
      {counts?.total ? (
        <section className="notification-inbox" aria-label="Announcements">
          <div className="notification-inbox-heading">
            <div>
              <span className="eyebrow">YOUR INBOX</span>
              <p className="notification-summary">
                {counts!.unreadCount ? `${counts!.unreadCount} unread` : 'You’re all caught up'}
              </p>
            </div>
            <span className="muted">
              {counts!.total} {counts!.total === 1 ? 'notice' : 'notices'}
            </span>
          </div>
          <div className="notification-filters" role="group" aria-label="Filter notifications">
            <button
              type="button"
              className={`notification-filter${filter === 'ALL' ? ' is-selected' : ''}`}
              aria-pressed={filter === 'ALL'}
              onClick={() => setFilter('ALL')}
            >
              All <span>{counts!.total}</span>
            </button>
            <button
              type="button"
              className={`notification-filter${filter === 'UNREAD' ? ' is-selected' : ''}`}
              aria-pressed={filter === 'UNREAD'}
              onClick={() => setFilter('UNREAD')}
            >
              Unread <span>{counts!.unreadCount}</span>
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
                      className="button text small"
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
                      className="button secondary small"
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
          {inbox.hasNextPage ? (
            <button
              className="button secondary"
              disabled={inbox.isFetchingNextPage}
              onClick={() => void inbox.fetchNextPage()}
            >
              {inbox.isFetchingNextPage ? 'Loading…' : 'Load more notifications'}
            </button>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
