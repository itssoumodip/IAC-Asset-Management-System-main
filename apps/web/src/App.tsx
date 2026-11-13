import { Children, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, resetCsrf, setViewAs } from './api';
import { ViewAsBanner, ViewAsMenu } from './components/ViewAs';
import { useSession, can, roleLabel, teamChipLabel } from './session';
import { AuthScreen, AccessScreen, SecurityScreen } from './components/Auth';
import { AssetList, AssetEditor } from './components/Assets';
import { AssetAssignTransfer } from './components/AssetAssignTransfer';
import { AssetDetailZoho as AssetDetail } from './components/AssetDetailZoho';
import { ScanPage } from './components/Scan';
import { LabelPrintPage } from './components/Labels';
import { rememberReturnTo, clearReturnTo } from './return-to';
import { InstallAppPage, InstallMenuItem, OfflineScreen } from './components/Pwa';
import { ScanButton } from './components/Scanner';
import { TicketForm, TicketList, TicketDetail } from './components/Tickets';
import { UserDashboard } from './components/Dashboards';
import { UserAdmin, AuditView, ImportsView } from './components/Admin';
import { RoleFieldPermissions } from './components/RoleFieldPermissions';
import { Locations } from './components/Locations';
import { Categories } from './components/Categories';
import { MyAssets } from './components/MyAssets';
import { Requests } from './components/Requests';
import { Approvals } from './components/Approvals';
import { Inventory } from './components/Inventory';
import { Empty, ErrorNotice, Field, Loading, Avatar, buttonClass, cx } from './components/ui';
import { BrandMark } from './components/BrandMark';
import { PageTransition } from './components/PageTransition';
import { TeamMembers, TeamsAndProjects } from './components/TeamAdmin';
import { Depreciation } from './components/Depreciation';
import { Store } from './components/Store';
import { TeamTransfers } from './components/TeamTransfers';
import { Maintenance } from './components/Maintenance';
import { Verification } from './components/Verification';
import { Directory } from './components/Directory';
import { FinanceReview } from './components/FinanceReview';
import { PushAnnouncements } from './components/PushAnnouncements';
import { Reports } from './components/Reports';
import { Insurance } from './components/Insurance';
import { Procurement } from './components/Procurement';
import { NotificationsPage, useUnreadNotificationCount } from './components/Notifications';
import { ChangeRequests } from './components/ChangeRequests';
import { useAction } from './hooks';
import { greeting, todayLabel } from './executive';
import type { Action } from './types';
function Guard({ action, anyOf }: { action?: Action; anyOf?: Action[] }) {
  const { user, loading, error } = useSession();
  const location = useLocation();
  const remember = () => rememberReturnTo(location.pathname + location.search);
  if (loading) return <Loading />;
  if (error) {
    if (!navigator.onLine) {
      return (
        <div
          role="alert"
          className="m-4 rounded-lg border border-sheet-edge bg-white p-6 text-center text-ink"
        >
          You're offline. Connect to the internet to scan or raise a ticket.
        </div>
      );
    }
    return <ErrorNotice error={error} retry={() => window.location.reload()} />;
  }
  if (!user) {
    remember();
    return <Navigate to="/login" replace />;
  }
  if (user.enrollmentOnly || user.mfaRequired || user.mfaEnrollmentRequired) {
    remember();
    return <Navigate to="/security" replace />;
  }
  if (
    !user.emailVerifiedAt ||
    !user.portalAcceptedAt ||
    user.portalNoticeVersion !== (user.currentNoticeVersion ?? '1')
  ) {
    remember();
    return <Navigate to="/access" replace />;
  }
  if ((action && !can(user, action)) || (anyOf && !anyOf.some((item) => can(user, item))))
    return <Empty title="Access required">Your account does not have access to this area.</Empty>;
  return <Outlet />;
}
// One outline icon per sidebar destination (24px grid, 1.5px stroke, round joins).
const navIconPaths = {
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  myAssets: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M3 19c0-2.8 2.2-4.5 5-4.5" />
      <rect x="12" y="12" width="9" height="8" rx="1" />
      <path d="M12 15h9" />
    </>
  ),
  requests: (
    <>
      <path d="M3 4h2l2.2 10.5a1 1 0 0 0 1 .8h8.6a1 1 0 0 0 1-.8L20 8H6.2" />
      <circle cx="9" cy="19" r="1.3" />
      <circle cx="17" cy="19" r="1.3" />
    </>
  ),
  support: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="m6 6 3.5 3.5M14.5 14.5 18 18M18 6l-3.5 3.5M9.5 14.5 6 18" />
    </>
  ),
  assets: (
    <>
      <path d="M3.5 8h17v11.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
      <path d="M2.5 4h19v4h-19z" />
      <path d="M9.5 12h5" />
    </>
  ),
  approvals: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  transfers: <path d="M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3" />,
  labels: (
    <>
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <path d="M14 14h2v2h-2zM18 14h2M14 18v2h2M18 18h2v2h-2z" />
    </>
  ),
  inventory: <path d="M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5" />,
  store: <path d="M3 9.5 12 4l9 5.5V20H3zM7 20v-7h10v7M7 16.5h10" />,
  locations: (
    <>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </>
  ),
  maintenance: (
    <path d="M14.5 6.5a4 4 0 0 0-5.3 5.3L4 17v3h3l5.2-5.2a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.5-.5-.5-2.5z" />
  ),
  verification: (
    <>
      <rect x="5" y="4.5" width="14" height="16.5" rx="2" />
      <path d="M9 4.5v-1h6v1M9 13l2 2 4-4" />
    </>
  ),
  finance: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />,
  depreciation: <path d="m3 7 6 6 4-4 8 8M15 17h6v-6" />,
  reports: <path d="M4 20h16M7 16v-5M12 16V7M17 16V9" />,
  insurance: <path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7z" />,
  procurement: (
    <>
      <path d="M3 6h11v10H3zM14 10h4l3 3v3h-7" />
      <circle cx="7" cy="18" r="1.8" />
      <circle cx="17" cy="18" r="1.8" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20c0-3 2.7-5 6-5s6 2 6 5" />
      <path d="M16 5a3 3 0 0 1 0 6" />
      <path d="M18 20c0-2.5-1-4.2-2.5-5.2" />
    </>
  ),
  directory: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <circle cx="12" cy="10" r="2.5" />
      <path d="M8.5 17c.6-1.8 2-2.8 3.5-2.8s2.9 1 3.5 2.8M3 7h2M3 12h2M3 17h2" />
    </>
  ),
  teams: (
    <>
      <circle cx="12" cy="8" r="2.8" />
      <path d="M6.5 19c0-3 2.5-4.8 5.5-4.8s5.5 1.8 5.5 4.8" />
      <circle cx="5.5" cy="10" r="2" />
      <circle cx="18.5" cy="10" r="2" />
    </>
  ),
  categories: (
    <>
      <path d="M3.5 12.5v-8a1 1 0 0 1 1-1h8l8 8-9 9z" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  roles: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M16 7l2 2M14 9l2 2" />
    </>
  ),
  master: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="9" cy="7" r="2" />
      <circle cx="15" cy="12" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
  imports: (
    <>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </>
  ),
  announcements: <path d="M4 10v4h3l7 4V6l-7 4zM17 9.5a3.5 3.5 0 0 1 0 5" />,
  audit: <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4l3 2" />,
  notifications: (
    <>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>
  ),
  install: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
};
type NavIconName = keyof typeof navIconPaths;
function NavIcon({ name }: { name: NavIconName }) {
  const paths = navIconPaths;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cx(
    'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm no-underline shadow-none ring-0 transition-colors duration-150 outline-none focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-navy-500',
    isActive
      ? 'bg-navy-50 font-medium text-navy-700 before:absolute before:inset-y-1.5 before:left-0 before:w-[3px] before:rounded-full before:bg-navy-700'
      : 'text-gray-600 hover:bg-gray-50 hover:text-navy-900',
  );
function SideLink({
  to,
  icon,
  children,
  className,
  end,
}: {
  end?: boolean;
  to: string;
  icon: Parameters<typeof NavIcon>[0]['name'];
  children: ReactNode;
  className?: string;
}) {
  return (
    <NavLink to={to} end={end} className={(state) => cx(navLinkClass(state), className)}>
      {({ isActive }) => (
        <>
          <span
            className={cx(
              'grid size-5 shrink-0 place-items-center [&>svg]:size-[18px]',
              isActive ? 'text-navy-700' : 'text-gray-400 group-hover:text-navy-700',
            )}
          >
            <NavIcon name={icon} />
          </span>
          <span className="truncate">{children}</span>
        </>
      )}
    </NavLink>
  );
}
/** A labelled sidebar section; hidden when the user can see none of its links. */
function NavGroup({
  label,
  ariaLabel,
  children,
}: {
  label: string;
  ariaLabel: string;
  children: ReactNode;
}) {
  const items = Children.toArray(children);
  if (!items.length) return null;
  return (
    <div className="mt-5 first:mt-1">
      <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-400">
        {label}
      </p>
      <nav aria-label={ariaLabel} className="flex flex-col gap-0.5">
        {items}
      </nav>
    </div>
  );
}
/** Time-of-day greeting with today's date, shown at the left of the top bar. */
function TopbarGreeting({ name }: { name: string }) {
  const now = new Date();
  const display = name.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
  return (
    <div className="hidden min-w-0 flex-col leading-tight sm:flex">
      <span className="truncate text-[0.95rem] font-semibold text-navy-900">
        {greeting(now, display)}
      </span>
      <time dateTime={now.toISOString()} className="text-xs text-gray-500">
        {todayLabel(now)}
      </time>
    </div>
  );
}
function Shell() {
  const { user } = useSession();
  if (!user) return null;
  const [menuOpen, setMenuOpen] = useState(false);
  // Desktop only: hide the sidebar to give pages the full width. Remembered per browser.
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('iac.sidebar') === 'collapsed';
    } catch {
      return false;
    }
  });
  function toggleSidebar() {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      const next = !collapsed;
      setCollapsed(next);
      try {
        localStorage.setItem('iac.sidebar', next ? 'collapsed' : 'open');
      } catch {
        // Storage unavailable (private mode); the choice just isn't remembered.
      }
    } else {
      setMenuOpen(!menuOpen);
    }
  }
  const [logoutError, setLogoutError] = useState<unknown>();
  const [signingOut, setSigningOut] = useState(false);
  const client = useQueryClient();
  const notificationCount = useUnreadNotificationCount();
  const unread = notificationCount.data?.unreadCount ?? 0;

  async function logout() {
    setSigningOut(true);
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
      resetCsrf();
      setViewAs(null);
      clearReturnTo();
      client.clear();
      window.location.assign('/login');
    } catch (error) {
      setLogoutError(error);
    } finally {
      setSigningOut(false);
    }
  }
  const leadTeams = (user.teams ?? []).filter((t) => t.level === 'LEAD');
  return (
    <div className="min-h-dvh bg-frame font-sans text-ink">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-navy-700 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>
      {menuOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-30 bg-navy-950/40 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}
      <aside
        id="mobile-nav"
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-gray-200 bg-white transition-transform duration-200',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'lg:-translate-x-full' : 'lg:translate-x-0',
        )}
      >
        {/* Four-colour rule taken from the IAC logo. */}
        <div className="grid h-1 shrink-0 grid-cols-4" aria-hidden="true">
          <span className="bg-navy-700" />
          <span className="bg-sky-500" />
          <span className="bg-red-600" />
          <span className="bg-yellow-500" />
        </div>
        <Link
          to="/dashboard"
          className="flex items-center gap-3 px-5 pt-5 pb-3 no-underline"
          onClick={() => setMenuOpen(false)}
        >
          <BrandMark size={36} />
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-gray-500">
              India Autism Center
            </span>
            <strong className="text-[0.95rem] font-semibold text-navy-900">Asset Management</strong>
          </span>
        </Link>
        <div className="flex-1 overflow-y-auto px-3 pb-4" onClick={() => setMenuOpen(false)}>
          <NavGroup label="Workspace" ariaLabel="Main navigation">
            <SideLink to="/dashboard" icon="overview">
              Dashboard
            </SideLink>
            <SideLink to="/my-assets" icon="myAssets">
              My assets
            </SideLink>
            <SideLink to="/requests" icon="requests">
              Requests
            </SideLink>
            <SideLink to="/tickets" icon="support">
              Support
            </SideLink>
            <SideLink to="/install" icon="install" className="min-[651px]:hidden">
              Install app
            </SideLink>
          </NavGroup>
          <NavGroup label="Assets" ariaLabel="Assets navigation">
            {can(user, 'asset.view_all') && (
              <SideLink to="/assets" icon="assets" end>
                Asset catalog
              </SideLink>
            )}
            {/* Same rule as the /approvals route and API: team leads and Super Admin. */}
            {(can(user, 'approvals.act') || can(user, 'system.admin')) && (
              <SideLink to="/approvals" icon="approvals">
                Approvals
              </SideLink>
            )}
            {/* Protected-field edits wait for the role that owns the field. */}
            {user.roles.some((role) => ['SUPER_ADMIN', 'STORE', 'AUDITOR', 'TECHNICIAN'].includes(role)) && (
              <SideLink to="/admin/change-requests" icon="approvals">
                Change approvals
              </SideLink>
            )}
            {(can(user, 'asset.edit') || can(user, 'system.admin')) && (
              <SideLink to="/transfers" icon="transfers">
                Transfers
              </SideLink>
            )}
            {can(user, 'asset.label') && (
              <SideLink to="/assets/labels" icon="labels">
                Print labels
              </SideLink>
            )}
          </NavGroup>
          <NavGroup label="Inventory & store" ariaLabel="Inventory navigation">
            {can(user, 'system.admin') && (
              <SideLink to="/inventory" icon="inventory">
                Inventory
              </SideLink>
            )}
            {can(user, 'store.operations') && (
              <SideLink to="/store" icon="store">
                Store
              </SideLink>
            )}
            {can(user, 'system.admin') && (
              <SideLink to="/locations" icon="locations">
                Locations
              </SideLink>
            )}
          </NavGroup>
          <NavGroup label="Maintenance & audit" ariaLabel="Maintenance navigation">
            {can(user, 'ticket.work') && (
              <SideLink to="/maintenance" icon="maintenance">
                Maintenance
              </SideLink>
            )}
            {can(user, 'verification.perform') && (
              <SideLink to="/verification" icon="verification">
                Verification
              </SideLink>
            )}
          </NavGroup>
          <NavGroup label="Finance & reports" ariaLabel="Finance navigation">
            {can(user, 'asset.finance_edit') && (
              <SideLink to="/finance" icon="finance">
                Finance review
              </SideLink>
            )}
            {can(user, 'asset.finance_edit') && (
              <SideLink to="/depreciation" icon="depreciation">
                Depreciation
              </SideLink>
            )}
            {can(user, 'report.view') && (
              <SideLink to="/reports" icon="reports">
                Reports
              </SideLink>
            )}
            {can(user, 'insurer.view') && (
              <SideLink to="/insurance" icon="insurance">
                Insurance
              </SideLink>
            )}
            {can(user, 'procurement.view') && (
              <SideLink to="/procurement" icon="procurement">
                Procurement
              </SideLink>
            )}
          </NavGroup>
          {can(user, 'system.admin') ? (
            <NavGroup label="Administration" ariaLabel="Administration navigation">
              <SideLink to="/admin/users" icon="people">
                People &amp; access
              </SideLink>
              <SideLink to="/admin/directory" icon="directory">
                Directory &amp; Zoho
              </SideLink>
              <SideLink to="/admin/teams" icon="teams">
                Teams
              </SideLink>
              <SideLink to="/categories" icon="categories">
                Categories
              </SideLink>
              <SideLink to="/admin/roles" icon="roles">
                Field permissions
              </SideLink>
              <SideLink to="/admin/imports" icon="imports">
                Import review
              </SideLink>
              {can(user, 'announcement.send') && (
                <SideLink to="/admin/announcements" icon="announcements">
                  Announcements
                </SideLink>
              )}
              <SideLink to="/admin/audit" icon="audit">
                Audit trail
              </SideLink>
            </NavGroup>
          ) : null}
          {leadTeams.length ? (
            <NavGroup label="My teams" ariaLabel="Team navigation">
              {leadTeams.map((t) => (
                <SideLink key={t.teamId} to={`/team/${t.teamId}`} icon="teams">
                  My team ({t.teamCode})
                </SideLink>
              ))}
            </NavGroup>
          ) : null}
        </div>
        {/* px-6 matches the nav links (3 + 3), so the dot sits in the icon column. */}
        <div className="flex shrink-0 items-center gap-3 border-t border-gray-100 bg-white px-6 py-3.5 text-xs">
          <span className="grid size-5 place-items-center" aria-hidden="true">
            <span className="size-2 rounded-full bg-sky-500" />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="m-0 font-medium text-gray-600">Secure staff portal</span>
            <span className="m-0 mt-0.5 text-gray-400">Asset operations · v0.1</span>
          </span>
        </div>
      </aside>
      <div
        className={cx(
          'flex min-h-dvh flex-col transition-[padding] duration-200',
          collapsed ? 'lg:pl-0' : 'lg:pl-64',
        )}
      >
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-2 border-b border-gray-200 bg-white/95 px-4 backdrop-blur sm:gap-3 sm:px-6">
          <button
            type="button"
            className="grid size-9 shrink-0 place-items-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-navy-800"
            onClick={toggleSidebar}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="size-5"
              aria-hidden="true"
            >
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <path d="M9.5 4.5v15" />
              <path d={collapsed ? 'm13 10 2 2-2 2' : 'm15 10-2 2 2 2'} strokeLinecap="round" />
            </svg>
            <span className="sr-only">{collapsed ? 'Show sidebar' : 'Hide sidebar'}</span>
          </button>
          <TopbarGreeting name={user.displayName} />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <ViewAsMenu />
            <NavLink
              to="/notifications"
              className={({ isActive }) =>
                cx(
                  'relative grid size-9 place-items-center rounded-lg transition-colors [&>svg]:size-5',
                  isActive
                    ? 'bg-navy-50 text-navy-700'
                    : 'text-gray-500 hover:bg-gray-100 hover:text-navy-800',
                )
              }
              aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
            >
              <NavIcon name="notifications" />
              {unread ? (
                <span
                  className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] leading-none font-semibold text-white ring-2 ring-white"
                  aria-hidden="true"
                >
                  {unread > 99 ? '99+' : unread}
                </span>
              ) : null}
            </NavLink>
            <ScanButton />
            <InstallMenuItem className="install-header-button" />
            <Link
              to="/profile"
              className="flex items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 no-underline transition-colors hover:bg-gray-100"
            >
              <Avatar userId={user.id} name={user.displayName} hasPhoto={user.hasPhoto} size={32} />
              <span className="hidden min-w-0 flex-col leading-tight sm:flex">
                <span className="max-w-44 truncate text-sm font-medium text-gray-900">
                  {user.displayName || 'My profile'}
                </span>
                <small className="max-w-44 truncate text-[11px] tracking-normal text-gray-500 normal-case">
                  {[...user.roles.map(roleLabel), ...(user.teams?.map(teamChipLabel) ?? [])].join(
                    ' · ',
                  )}
                </small>
              </span>
            </Link>
            <button
              className={buttonClass('ghost', 'sm')}
              type="button"
              onClick={logout}
              disabled={signingOut}
            >
              Sign out
            </button>
          </div>
        </header>
        <ViewAsBanner />
        <main
          id="main"
          tabIndex={-1}
          className={cx(
            'mx-auto w-full flex-1 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8',
            // Hidden sidebar means the user wants every pixel: drop the reading-width cap.
            collapsed ? 'max-w-none' : 'max-w-[1480px]',
          )}
        >
          {logoutError ? <ErrorNotice error={logoutError} /> : null}
          <OfflineScreen />
          <Outlet />
          <footer className="mt-12 flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-4 text-xs text-gray-400">
            <span>
              <span className="font-medium text-gray-600">IAC Patrons Foundation</span> · India
              Autism Center, Kolkata
            </span>
            <span>Asset Management Platform · v0.1</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Profile() {
  const { user } = useSession();
  if (!user) return null;
  const profileAction = useAction<{ message: string }>();
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [designation, setDesignation] = useState(user?.designation ?? '');
  const [newEmail, setNewEmail] = useState(user?.email ?? '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saved, setSaved] = useState('');
  const [cancelPendingEmail, setCancelPendingEmail] = useState(false);
  const action = async () => {
    await api('/auth/logout-all', { method: 'POST', body: {} });
    window.location.assign('/login');
  };
  const [error, setError] = useState<unknown>();
  async function saveProfile(event: FormEvent) {
    event.preventDefault();
    setSaved('');
    if (newPassword && newPassword !== confirmPassword) {
      setError(new Error('The new passwords do not match.'));
      return;
    }
    const emailChanged = newEmail.trim().toLowerCase() !== user?.email;
    const passwordChanged = newPassword.length > 0;
    const result = await profileAction
      .mutateAsync({
        path: '/me/profile',
        method: 'PATCH',
        version: user?.version,
        body: {
          displayName: displayName.trim(),
          designation: designation.trim() || null,
          ...(emailChanged || cancelPendingEmail ? { newEmail } : {}),
          ...(passwordChanged ? { newPassword } : {}),
          ...(emailChanged || cancelPendingEmail || passwordChanged ? { currentPassword } : {}),
        },
      })
      .catch(() => undefined);
    if (result) {
      setSaved(result.message);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setCancelPendingEmail(false);
      setError(undefined);
    }
  }
  return (
    <section className="profile-page">
      <div className="profile-header">
        <Avatar userId={user.id} name={user.displayName} hasPhoto={user.hasPhoto} size={96} />
        <div className="profile-identity">
          <h1>{user.displayName}</h1>
          <p className="muted">{user.email}</p>
        </div>
      </div>
      <ErrorNotice error={profileAction.error} />
      {saved ? (
        <p className="notice success" role="status">
          {saved}
        </p>
      ) : null}
      <form className="profile-form" onSubmit={(event) => void saveProfile(event)}>
        <div className="profile-grid">
          <Field label="Name" htmlFor="profile-name">
            <input
              id="profile-name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
              maxLength={120}
            />
          </Field>
          <Field
            label="Work email"
            htmlFor="profile-email"
            hint={
              user?.pendingEmail
                ? `Pending confirmation: ${user.pendingEmail}`
                : 'Changing your email requires your current password and email confirmation. Only addresses approved by an administrator can be used.'
            }
          >
            <input
              id="profile-email"
              type="email"
              value={newEmail}
              onChange={(event) => {
                setNewEmail(event.target.value);
                setCancelPendingEmail(false);
              }}
              required
              maxLength={254}
            />
          </Field>
          {user?.pendingEmail && !cancelPendingEmail ? (
            <button
              className="button secondary profile-cancel-email"
              type="button"
              onClick={() => {
                setNewEmail(user.email);
                setCancelPendingEmail(true);
              }}
            >
              Cancel pending email change
            </button>
          ) : null}
          <Field label="Designation" htmlFor="profile-designation">
            <input
              id="profile-designation"
              value={designation}
              onChange={(event) => setDesignation(event.target.value)}
              maxLength={120}
            />
          </Field>
          <Field label="Department" htmlFor="profile-department">
            <span className="profile-readonly">{user?.department ?? 'Not set'}</span>
          </Field>
          <Field label="Access roles" htmlFor="profile-roles">
            <span className="profile-readonly">
              {[
                ...(user?.roles.map(roleLabel) ?? []),
                ...(user?.teams?.map(teamChipLabel) ?? []),
              ].join(', ')}
            </span>
          </Field>
        </div>
        {newEmail.trim().toLowerCase() !== user?.email ||
        cancelPendingEmail ||
        newPassword.length > 0 ? (
          <Field label="Current password" htmlFor="profile-current-password">
            <input
              id="profile-current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
        ) : null}
        <Field
          label="New password"
          htmlFor="profile-new-password"
          hint="Leave blank to keep your current password. Use at least 12 characters."
        >
          <input
            id="profile-new-password"
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            minLength={12}
            autoComplete="new-password"
          />
        </Field>
        {newPassword ? (
          <Field label="Confirm new password" htmlFor="profile-confirm-password">
            <input
              id="profile-confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={12}
              autoComplete="new-password"
            />
          </Field>
        ) : null}
        <button className="button profile-save" disabled={profileAction.isPending}>
          {profileAction.isPending ? 'Saving…' : 'Save account details'}
        </button>
      </form>
      <p className="profile-notice">
        Portal notice: {user?.portalNoticeVersion ?? '1'} ·{' '}
        {user?.portalAcceptedAt ? 'Accepted' : 'Pending'}
      </p>
      <ErrorNotice error={error} />
      <div className="profile-actions">
        <Link className="button secondary" to="/security">
          Security settings
        </Link>
        <button
          type="button"
          className="button secondary"
          onClick={() => {
            void action().catch(setError);
          }}
        >
          Sign out of all sessions
        </button>
      </div>
    </section>
  );
}
export function App() {
  return (
    <>
      <PageTransition />
      <Routes>
        <Route path="/login" element={<AuthScreen key="login" mode="login" />} />
        <Route path="/register" element={<AuthScreen key="register" mode="register" />} />
        <Route path="/forgot-password" element={<AuthScreen key="forgot" mode="forgot" />} />
        <Route path="/reset-password" element={<AuthScreen key="reset" mode="reset" />} />
        <Route path="/verify-email" element={<AuthScreen key="verify" mode="verify" />} />
        <Route path="/invite" element={<AuthScreen key="invite" mode="invite" />} />
        <Route path="/access" element={<AccessScreen />} />
        <Route path="/security" element={<SecurityScreen />} />
        <Route element={<Guard />}>
          <Route element={<Shell />}>
            <Route path="/dashboard" element={<UserDashboard />} />
            <Route path="/my-assets" element={<MyAssets />} />
            <Route path="/requests" element={<Requests />} />
            <Route path="/assets" element={<AssetList />} />
            <Route path="/a/:assetCode" element={<ScanPage />} />
            <Route path="/assets/:id" element={<AssetDetail />} />
            <Route path="/transfers" element={<TeamTransfers />} />
            <Route path="/tickets" element={<TicketList />} />
            <Route path="/tickets/new" element={<TicketForm />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            {/* Store, Auditor and Technician review edits to fields they own; the API scopes by role. */}
            <Route path="/admin/change-requests" element={<ChangeRequests />} />
            <Route path="/install" element={<InstallAppPage />} />
            <Route element={<Guard action="announcement.send" />}>
              <Route path="/admin/announcements" element={<PushAnnouncements />} />
            </Route>
            <Route element={<Guard action="asset.custody" />}>
              <Route
                path="/assignments/new"
                element={<AssetList key="assignment" assignmentMode />}
              />
              <Route path="/assets/:id/assign" element={<AssetAssignTransfer />} />
            </Route>
            <Route element={<Guard action="asset.create" />}>
              <Route path="/assets/new" element={<AssetEditor />} />
            </Route>
            <Route element={<Guard action="asset.label" />}>
              <Route path="/assets/labels" element={<LabelPrintPage />} />
            </Route>
            <Route element={<Guard anyOf={['asset.edit', 'asset.finance_edit']} />}>
              <Route path="/assets/:id/edit" element={<AssetEditor />} />
            </Route>
            <Route element={<Guard action="asset.finance_edit" />}>
              <Route path="/finance" element={<FinanceReview />} />
              <Route path="/depreciation" element={<Depreciation />} />
            </Route>
            <Route element={<Guard action="report.view" />}>
              <Route path="/reports" element={<Reports />} />
            </Route>
            <Route element={<Guard action="insurer.view" />}>
              <Route path="/insurance" element={<Insurance />} />
            </Route>
            <Route element={<Guard action="procurement.view" />}>
              <Route path="/procurement" element={<Procurement />} />
            </Route>
            {/* TeamMembers checks team.manage_members for the team in the URL itself. */}
            <Route path="/team/:teamId" element={<TeamMembers />} />
            <Route element={<Guard action="system.admin" />}>
              <Route path="/admin/imports" element={<ImportsView />} />
            </Route>
            <Route element={<Guard action="store.operations" />}>
              <Route path="/store" element={<Store />} />
            </Route>
            <Route element={<Guard action="ticket.work" />}>
              <Route path="/maintenance" element={<Maintenance />} />
            </Route>
            {/* Auditors verify; the API checks verification.perform, so the page does too. */}
            <Route element={<Guard action="verification.perform" />}>
              <Route path="/verification" element={<Verification />} />
            </Route>
            <Route element={<Guard action="system.admin" />}>
              <Route path="/admin/roles" element={<RoleFieldPermissions />} />
              <Route path="/admin/teams" element={<TeamsAndProjects />} />
              <Route path="/admin/locations" element={<Locations />} />
              {/* Main's field-permission page is covered by the fuller /admin/roles page. */}
              <Route path="/admin/field-permissions" element={<Navigate to="/admin/roles" replace />} />
              <Route path="/admin/directory" element={<Directory />} />
              <Route path="/admin/users" element={<UserAdmin />} />
              <Route path="/admin/audit" element={<AuditView />} />
            </Route>
            <Route element={<Guard anyOf={['approvals.act', 'system.admin']} />}>
              <Route path="/approvals" element={<Approvals />} />
            </Route>
            <Route element={<Guard action="asset.view_all" />}>
              <Route path="/locations" element={<Locations />} />
              <Route path="/categories" element={<Categories />} />
              <Route path="/inventory" element={<Inventory />} />
            </Route>
          </Route>
        </Route>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route
          path="*"
          element={
            <Empty
              title="Page not found"
              action={
                <Link className="button" to="/dashboard">
                  Back to workspace
                </Link>
              }
            >
              This page is not available.
            </Empty>
          }
        />
      </Routes>
    </>
  );
}
