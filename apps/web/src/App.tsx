import { LifecyclePage } from './components/Lifecycle';
import { StocktakePage } from './components/Stocktake';
import { useState, useEffect, useRef } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, resetCsrf } from './api';
import { useSession, hasRole, isStaff } from './session';
import { AuthScreen, AccessScreen, SecurityScreen } from './components/Auth';
import { AssetList, AssetDetail, AssetEditor, AssignmentForm } from './components/Assets';
import { ScanPage } from './components/Scan';
import { LabelPrintPage } from './components/Labels';
import { rememberReturnTo, clearReturnTo } from './return-to';
import { InstallAppPage, InstallMenuItem, OfflineScreen } from './components/Pwa';
import { ScanButton } from './components/Scanner';
import { TicketForm, TicketList, TicketDetail } from './components/Tickets';
import { UserDashboard } from './components/Dashboards';
import { UserAdmin, AuditView, ImportsView } from './components/Admin';
import { Empty, ErrorNotice, Field, Loading } from './components/ui';
import { BrandMark } from './components/BrandMark';
import { PageTransition } from './components/PageTransition';
import { MasterControl } from './components/MasterControl';
import { PushAnnouncements } from './components/PushAnnouncements';
import { NotificationsPage, useUnreadNotificationCount } from './components/Notifications';
import { useAction } from './hooks';
import { EquipmentPeople, PersonEquipment } from './components/Equipment';
import { DeliveryHealth } from './components/DeliveryHealth';
import { FinanceQueue, FinanceDetail, ExecutiveDashboard } from './components/Finance';
function Guard({ admin = false, staffOnly = false }: { admin?: boolean; staffOnly?: boolean }) {
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
  if (admin && !hasRole(user, 'ADMIN'))
    return (
      <Empty title="Admin access required">Your account does not have access to this area.</Empty>
    );
  if (staffOnly && !isStaff(user))
    return (
      <Empty title="Staff access required">Your account does not have access to this area.</Empty>
    );
  return <Outlet />;
}
type NavIconName =
  | 'overview'
  | 'assets'
  | 'tickets'
  | 'master'
  | 'people'
  | 'imports'
  | 'audit'
  | 'notifications'
  | 'install'
  | 'push'
  | 'menu';
function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, ReactNode> = {
    overview: (
      <>
        <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
      </>
    ),
    assets: (
      <>
        <path d="M3.5 8h17v11.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5Z" />
        <path d="M2.5 4h19v4h-19z" />
        <path d="M9.5 12h5" />
      </>
    ),
    tickets: (
      <>
        <path d="M4 5h16v14H4z" />
        <path d="M4 13h4l2 3h4l2-3h4" />
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
    people: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20c0-3 2.7-5 6-5s6 2 6 5" />
        <path d="M16 5a3 3 0 0 1 0 6" />
        <path d="M18 20c0-2.5-1-4.2-2.5-5.2" />
      </>
    ),
    imports: (
      <>
        <path d="M12 16V4" />
        <path d="m7 9 5-5 5 5" />
        <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
      </>
    ),
    audit: (
      <>
        <circle cx="12" cy="12" r="8.5" />
        <path d="M12 7v5l3.5 2" />
      </>
    ),
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
    push: (
      <>
        <path d="M12 3 4 7v5c0 5 3.5 8 8 9 4.5-1 8-4 8-9V7z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  };
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
function Shell() {
  const { user } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 650px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 650px)');
    const change = () => {
      setMobile(media.matches);
      setMenuOpen(false);
    };
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);
  const [logoutError, setLogoutError] = useState<unknown>();
  const [signingOut, setSigningOut] = useState(false);
  const client = useQueryClient();
  const notificationCount = useUnreadNotificationCount();

  async function logout() {
    setSigningOut(true);
    try {
      await api('/auth/logout', { method: 'POST', body: {} });
      resetCsrf();
      clearReturnTo();
      client.clear();
      window.location.assign('/login');
    } catch (error) {
      setLogoutError(error);
    } finally {
      setSigningOut(false);
    }
  }
  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      {mobile && menuOpen ? (
        <button
          className="nav-scrim"
          aria-label="Close navigation"
          onClick={() => {
            setMenuOpen(false);
            menuButton.current?.focus();
          }}
        />
      ) : null}
      <aside
        id="mobile-nav"
        inert={mobile && !menuOpen ? true : undefined}
        className={`sidebar ${menuOpen ? 'is-open' : ''}`}
      >
        <Link to="/dashboard" className="brand">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-org">IAC Patrons Foundation</span>
            <strong>Asset workspace</strong>
          </span>
        </Link>
        <p className="nav-label">Workspace</p>
        <nav aria-label="Main navigation" onClick={() => setMenuOpen(false)}>
          {hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE') ? (
            <NavLink to="/equipment/people">
              <span className="nav-icon">
                <NavIcon name="people" />
              </span>
              People &amp; equipment
            </NavLink>
          ) : hasRole(user, 'EMPLOYEE') ? (
            <NavLink to="/equipment/mine">
              <span className="nav-icon">
                <NavIcon name="assets" />
              </span>
              My equipment
            </NavLink>
          ) : null}
          <NavLink to="/dashboard">
            <span className="nav-icon">
              <NavIcon name="overview" />
            </span>
            Overview
          </NavLink>
          {hasRole(user, 'ADMIN') || hasRole(user, 'EMPLOYEE') || hasRole(user, 'IT_ADMIN') ? (
            <NavLink to="/assets">
              <span className="nav-icon">
                <NavIcon name="assets" />
              </span>
              {hasRole(user, 'ADMIN') ? 'Asset catalog' : 'Assets'}
            </NavLink>
          ) : null}
          {hasRole(user, 'ADMIN') || hasRole(user, 'EMPLOYEE') || hasRole(user, 'IT_ADMIN') ? (
            <NavLink to="/tickets">
              <span className="nav-icon">
                <NavIcon name="tickets" />
              </span>
              {isStaff(user) ? 'Support desk' : 'My tickets'}
            </NavLink>
          ) : null}
          {hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE') ? (
            <NavLink to="/finance">
              <span className="nav-icon">
                <NavIcon name="audit" />
              </span>
              Finance review
            </NavLink>
          ) : null}
          {hasRole(user, 'ADMIN') || hasRole(user, 'FINANCE') || hasRole(user, 'EXECUTIVE') ? (
            <NavLink to="/executive">
              <span className="nav-icon">
                <NavIcon name="overview" />
              </span>
              Executive overview
            </NavLink>
          ) : null}
          <NavLink
            to="/notifications"
            aria-label={
              notificationCount.data?.unreadCount
                ? `Notifications, ${notificationCount.data.unreadCount} unread`
                : 'Notifications'
            }
          >
            <span className="nav-icon">
              <NavIcon name="notifications" />
            </span>
            Notifications
            {notificationCount.data?.unreadCount ? (
              <span className="notification-nav-count" aria-hidden="true">
                {notificationCount.data.unreadCount > 99
                  ? '99+'
                  : notificationCount.data.unreadCount}
              </span>
            ) : null}
          </NavLink>
          <NavLink to="/install" className="install-app-nav">
            <span className="nav-icon">
              <NavIcon name="install" />
            </span>
            Install app
          </NavLink>
          {isStaff(user) ? (
            <>
              <p className="nav-label">Administration</p>
              <NavLink to="/admin/announcements">
                <span className="nav-icon">
                  <NavIcon name="push" />
                </span>
                Announcements
              </NavLink>
            </>
          ) : null}
          {hasRole(user, 'ADMIN') ? (
            <>
              <NavLink to="/assets/labels">
                <span className="nav-icon">
                  <NavIcon name="assets" />
                </span>
                Print labels
              </NavLink>
              <NavLink to="/master-control">
                <span className="nav-icon">
                  <NavIcon name="master" />
                </span>
                Master control
              </NavLink>
              <NavLink to="/admin/users">
                <span className="nav-icon">
                  <NavIcon name="people" />
                </span>
                People &amp; access
              </NavLink>
              <NavLink to="/admin/lifecycle">Lifecycle attention</NavLink>
              <NavLink to="/admin/stocktake">Physical stocktake</NavLink>
              <NavLink to="/admin/imports">
                <span className="nav-icon">
                  <NavIcon name="imports" />
                </span>
                Import review
              </NavLink>
              <NavLink to="/admin/deliveries">
                <span className="nav-icon">
                  <NavIcon name="audit" />
                </span>
                Email delivery
              </NavLink>
              <NavLink to="/admin/audit">
                <span className="nav-icon">
                  <NavIcon name="audit" />
                </span>
                Audit trail
              </NavLink>
            </>
          ) : null}
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" />
          Secure staff portal
          <p>Asset operations · v0.1</p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <button
            type="button"
            className="menu-button"
            ref={menuButton}
            onClick={() => setMenuOpen(!menuOpen)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
          >
            <NavIcon name="menu" />
            <span className="sr-only">Toggle navigation</span>
          </button>
          <span className="topbar-caption">
            Asset operations <span>·</span> Staff portal
          </span>
          <Link to="/profile" className="profile-link">
            <span className="avatar">{user?.displayName?.slice(0, 1) ?? 'U'}</span>
            <span>
              {user?.displayName || 'My profile'}
              <small>{user?.roles.map((role) => role.replace('_', ' ')).join(' · ')}</small>
            </span>
          </Link>
          <ScanButton />
          <InstallMenuItem className="install-header-button" />
          <button
            className="button text small"
            type="button"
            onClick={logout}
            disabled={signingOut}
          >
            Sign out
          </button>
        </header>
        <main id="main" tabIndex={-1}>
          {logoutError ? <ErrorNotice error={logoutError} /> : null}
          <OfflineScreen />
          <Outlet />
          <footer className="page-footer">
            IAC Patrons Foundation<span>Asset Management Platform · v0.1</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Profile() {
  const { user } = useSession();
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
    <section className="panel profile-panel">
      <h1>Account details</h1>
      <p className="muted">
        Update your profile. Role and department changes are managed by an administrator.
      </p>
      <ErrorNotice error={profileAction.error} />
      {saved ? (
        <p className="notice success" role="status">
          {saved}
        </p>
      ) : null}
      <form className="form-stack" onSubmit={(event) => void saveProfile(event)}>
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
            className="button secondary"
            type="button"
            onClick={() => {
              setNewEmail(user.email);
              setCancelPendingEmail(true);
            }}
          >
            Cancel pending email change
          </button>
        ) : null}
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
        <Field label="Designation" htmlFor="profile-designation">
          <input
            id="profile-designation"
            value={designation}
            onChange={(event) => setDesignation(event.target.value)}
            maxLength={120}
          />
        </Field>
        <Field label="Department" htmlFor="profile-department">
          <input id="profile-department" value={user?.department ?? 'Not set'} readOnly />
        </Field>
        <Field label="Access roles" htmlFor="profile-roles">
          <input id="profile-roles" value={user?.roles.join(', ') ?? ''} readOnly />
        </Field>
        <button className="button" disabled={profileAction.isPending}>
          {profileAction.isPending ? 'Saving…' : 'Save account details'}
        </button>
      </form>
      <p>
        Portal notice: {user?.portalNoticeVersion ?? '1'} ·{' '}
        {user?.portalAcceptedAt ? 'Accepted' : 'Pending'}
      </p>
      <ErrorNotice error={error} />
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
            <Route path="/equipment/people" element={<EquipmentPeople />} />
            <Route path="/equipment/people/:id" element={<PersonEquipment />} />
            <Route path="/equipment/mine" element={<PersonEquipment />} />
            <Route path="/finance" element={<FinanceQueue />} />
            <Route path="/finance/:id" element={<FinanceDetail />} />
            <Route path="/executive" element={<ExecutiveDashboard />} />
            <Route path="/assets" element={<AssetList />} />
            <Route path="/a/:assetCode" element={<ScanPage />} />
            <Route path="/assets/:id" element={<AssetDetail />} />
            <Route path="/tickets" element={<TicketList />} />
            <Route path="/tickets/new" element={<TicketForm />} />
            <Route path="/tickets/:id" element={<TicketDetail />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/install" element={<InstallAppPage />} />
            <Route element={<Guard staffOnly />}>
              <Route path="/admin/announcements" element={<PushAnnouncements />} />
            </Route>
            <Route element={<Guard admin />}>
              <Route
                path="/assignments/new"
                element={<AssetList key="assignment" assignmentMode />}
              />
              <Route path="/assets/new" element={<AssetEditor />} />
              <Route path="/assets/labels" element={<LabelPrintPage />} />
              <Route path="/assets/:id/edit" element={<AssetEditor />} />
              <Route path="/assets/:id/assign" element={<AssignmentForm />} />
              <Route path="/master-control" element={<MasterControl />} />
              <Route path="/admin/users" element={<UserAdmin />} />
              <Route path="/admin/lifecycle" element={<LifecyclePage />} />
              <Route path="/admin/stocktake" element={<StocktakePage />} />
              <Route path="/admin/stocktake/:id" element={<StocktakePage />} />
              <Route path="/admin/imports" element={<ImportsView />} />
              <Route path="/admin/deliveries" element={<DeliveryHealth />} />
              <Route path="/admin/audit" element={<AuditView />} />
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
