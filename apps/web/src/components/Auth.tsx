import { useEffect, useRef, useState } from 'react';
import type { FormEvent, PropsWithChildren } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, captureFragmentToken, resetCsrf } from '../api';
import { useSession } from '../session';
import { takeReturnTo } from '../return-to';
import { ErrorNotice, Field, Loading } from './ui';
import { BrandMark } from './BrandMark';
// Capture at module load, before any render or analytics. Link tokens never enter browser storage.
let initialLinkToken = captureFragmentToken();
type AuthMode = 'login' | 'register' | 'forgot' | 'reset' | 'verify' | 'invite';
interface LoginResult {
  mfaRequired?: boolean;
  mfaEnrollmentRequired?: boolean;
  enrollmentRequired?: boolean;
  challengeToken?: string;
}
export function AccessLayout({ children }: PropsWithChildren) {
  return (
    <div className="access-layout">
      <main className="access-content" id="main">
        <Link to="/login" className="brand access-brand">
          <BrandMark />
          <span className="brand-text">
            <span className="brand-org">IAC Patrons Foundation</span>
            <strong>Asset workspace</strong>
          </span>
        </Link>
        <div className="access-sheet">
          {children}
          <p className="access-footer">IAC Asset Management · Staff access only</p>
        </div>
      </main>
    </div>
  );
}
export function AuthScreen({ mode }: { mode: AuthMode }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const { refresh } = useSession();
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [challenge, setChallenge] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [revealPassword, setRevealPassword] = useState(false);
  const [token, setToken] = useState(initialLinkToken);
  const [fields, setFields] = useState({ email: '', displayName: '', password: '', code: '' });
  const titles: Record<AuthMode, string> = {
    login: 'Welcome back',
    register: 'Create your account',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
    verify: 'Verify your email',
    invite: 'Accept your invitation',
  };
  async function signedIn() {
    resetCsrf();
    await client.cancelQueries();
    client.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
    await refresh();
    navigate(takeReturnTo(), { replace: true });
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    setMessage('');
    try {
      if (challenge) {
        await api(recovery ? '/auth/mfa/recover' : '/auth/mfa/verify', {
          method: 'POST',
          body: recovery
            ? { challengeToken: challenge, code: fields.code }
            : { challengeToken: challenge, code: fields.code },
        });
        await signedIn();
      } else if (mode === 'login') {
        const result = await api<LoginResult>('/auth/login', {
          method: 'POST',
          body: { email: fields.email.trim(), password: fields.password },
        });
        setFields((value) => ({ ...value, password: '' }));
        resetCsrf();
        if (result.mfaRequired && result.challengeToken) {
          setChallenge(result.challengeToken);
        } else if (result.mfaEnrollmentRequired || result.enrollmentRequired) {
          await refresh();
          navigate('/security', { replace: true });
        } else await signedIn();
      } else if (mode === 'register') {
        const result = await api<{ message: string }>('/auth/register', {
          method: 'POST',
          body: {
            email: fields.email.trim(),
            displayName: fields.displayName.trim(),
            password: fields.password,
          },
        });
        setMessage(result.message);
        setFields((value) => ({ ...value, password: '' }));
      } else if (mode === 'forgot') {
        const result = await api<{ message: string }>('/auth/forgot-password', {
          method: 'POST',
          body: { email: fields.email.trim() },
        });
        setMessage(result.message);
      } else {
        if (!token)
          throw new Error(
            'This link has no token. Open the original email link, or request a new one.',
          );
        const path =
          mode === 'verify'
            ? '/auth/verify-email'
            : mode === 'reset'
              ? '/auth/reset-password'
              : '/auth/invite/accept';
        const result = await api<{ message: string }>(path, {
          method: 'POST',
          body:
            mode === 'verify'
              ? { token }
              : {
                  token,
                  password: fields.password,
                  ...(mode === 'invite' ? { displayName: fields.displayName.trim() } : {}),
                },
        });
        setToken('');
        initialLinkToken = '';
        setFields((value) => ({ ...value, password: '' }));
        setMessage(result.message || 'Your request is complete. You can now sign in.');
      }
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }
  const needEmail = !challenge && ['login', 'register', 'forgot'].includes(mode);
  const needPassword = !challenge && ['login', 'register', 'reset', 'invite'].includes(mode);
  const isTokenMode = ['reset', 'invite', 'verify'].includes(mode);
  const nameShown = !challenge && (mode === 'register' || mode === 'invite');
  return (
    <AccessLayout>
      <div className="auth-card" key={mode}>
        <h1>{challenge ? 'One more security step' : titles[mode]}</h1>
        <p className="muted">
          {challenge
            ? recovery
              ? 'Enter one unused recovery code.'
              : 'Enter the six-digit code from your authenticator app.'
            : mode === 'login'
              ? 'Sign in with your approved work email.'
              : mode === 'register'
                ? 'Use the email address approved by your administrator.'
                : mode === 'verify'
                  ? 'Confirm this request to verify ownership of your email.'
                  : mode === 'invite'
                    ? 'Set a password to accept your invitation and verify your work email.'
                    : 'We will help you regain secure access.'}
        </p>
        <ErrorNotice error={error} />
        {message ? (
          <div className="notice success" role="status">
            {message}
            {isTokenMode ? (
              <p>
                <Link to="/login">Continue to sign in</Link>
              </p>
            ) : null}
          </div>
        ) : null}
        {!message || !isTokenMode ? (
          <form onSubmit={submit} className="form-stack">
            {(mode === 'register' || mode === 'invite') && !challenge ? (
              <Field label="Full name" htmlFor="displayName">
                <input
                  id="displayName"
                  autoComplete="name"
                  value={fields.displayName}
                  onChange={(event) => setFields({ ...fields, displayName: event.target.value })}
                  required
                  maxLength={120}
                  autoFocus={nameShown}
                />
              </Field>
            ) : null}
            {needEmail ? (
              <Field label="Work email" htmlFor="email">
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  value={fields.email}
                  onChange={(event) => setFields({ ...fields, email: event.target.value })}
                  maxLength={254}
                  required
                  autoFocus={!nameShown}
                />
              </Field>
            ) : null}
            {needPassword ? (
              <Field
                label={mode === 'login' ? 'Password' : 'New password'}
                htmlFor="password"
                hint={
                  mode === 'login'
                    ? undefined
                    : 'Use 12–128 characters. A unique passphrase is recommended.'
                }
              >
                <span className="input-affix">
                  <input
                    id="password"
                    type={revealPassword ? 'text' : 'password'}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={fields.password}
                    onChange={(event) => setFields({ ...fields, password: event.target.value })}
                    minLength={mode === 'login' ? 1 : 12}
                    maxLength={128}
                    required
                    autoFocus={!nameShown && !needEmail}
                  />
                  <button
                    type="button"
                    className="affix-toggle"
                    onClick={() => setRevealPassword((value) => !value)}
                    aria-pressed={revealPassword}
                    aria-label={revealPassword ? 'Hide password' : 'Show password'}
                  >
                    {revealPassword ? 'Hide' : 'Show'}
                  </button>
                </span>
              </Field>
            ) : null}
            {challenge ? (
              <Field label={recovery ? 'Recovery code' : 'Authenticator code'} htmlFor="code">
                <input
                  id="code"
                  autoComplete="one-time-code"
                  inputMode={recovery ? 'text' : 'numeric'}
                  value={fields.code}
                  onChange={(event) => setFields({ ...fields, code: event.target.value })}
                  pattern={recovery ? undefined : '[0-9]{6}'}
                  required
                  autoFocus
                />
              </Field>
            ) : null}
            <button
              type="submit"
              className="button full"
              disabled={pending || (isTokenMode && !token)}
            >
              {pending
                ? 'Please wait...'
                : challenge
                  ? 'Verify and sign in'
                  : mode === 'login'
                    ? 'Sign in to workspace'
                    : mode === 'register'
                      ? 'Create account'
                      : mode === 'forgot'
                        ? 'Send reset instructions'
                        : mode === 'verify'
                          ? 'Verify my email'
                          : 'Save password'}
            </button>
            {challenge ? (
              <button
                type="button"
                className="button text"
                onClick={() => {
                  setRecovery(!recovery);
                  setFields({ ...fields, code: '' });
                  setError(undefined);
                }}
              >
                {recovery ? 'Use authenticator app' : 'Use a recovery code'}
              </button>
            ) : null}
            {isTokenMode && !token ? (
              <p className="muted">
                Open the complete link from your email. Tokens are removed from the address bar for
                privacy.
              </p>
            ) : null}
          </form>
        ) : null}
        <div className="auth-links">
          {mode === 'login' ? (
            <>
              <Link to="/register">Register with approved email</Link>
              <Link to="/forgot-password">Forgot password?</Link>
            </>
          ) : (
            <Link to="/login">Back to sign in</Link>
          )}
        </div>
        <div className="auth-note">
          Admin, IT, Finance and Executive accounts use two-step verification. Your access is
          managed by IAC.
        </div>
      </div>
    </AccessLayout>
  );
}
function ReturnNavigate() {
  const navigate = useNavigate();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    navigate(takeReturnTo(), { replace: true });
  }, [navigate]);
  return null;
}
function ContinueLink({ disabled = false }: { disabled?: boolean }) {
  const navigate = useNavigate();
  return (
    <a
      href="/dashboard"
      className={`button ${disabled ? 'disabled' : ''}`}
      aria-disabled={disabled}
      onClick={(event) => {
        event.preventDefault();
        if (!disabled) navigate(takeReturnTo());
      }}
    >
      Continue to workspace
    </a>
  );
}
export function AccessScreen() {
  const { user, loading, error, refresh } = useSession();
  const [accepted, setAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<unknown>();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.enrollmentOnly || user.mfaRequired || user.mfaEnrollmentRequired)
    return <Navigate to="/security" replace />;
  if (
    user.emailVerifiedAt &&
    user.portalAcceptedAt &&
    user.portalNoticeVersion === (user.currentNoticeVersion ?? '1')
  )
    return <ReturnNavigate />;
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await api('/me/portal-acceptance', {
        method: 'POST',
        body: { noticeVersion: user?.currentNoticeVersion ?? '1' },
      });
      await refresh();
    } catch (error) {
      setActionError(error);
    } finally {
      setPending(false);
    }
  }
  return (
    <AccessLayout>
      <div className="auth-card">
        <h1>{user.emailVerifiedAt ? 'Your portal access' : 'Check your email'}</h1>
        <ErrorNotice error={error ?? actionError} />
        {!user.emailVerifiedAt ? (
          <>
            <p>Open the verification link sent to your approved email, then return here.</p>
            <button
              type="button"
              className="button"
              onClick={() => {
                void refresh();
              }}
            >
              I have verified my email
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            <div className="notice">
              <strong>Portal access notice · Version {user.currentNoticeVersion ?? '1'}</strong>
              <p>
                This portal records asset assignments, your confirmations, support requests, and
                timestamped activity. Authorized Admin and IT staff use these records to manage
                equipment and provide support.
              </p>
              <p>
                Keep your password private and include only information needed to resolve your
                request. Confirm each assigned asset separately after reviewing its details.
              </p>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
                required
              />
              I have read and accept portal access notice version {user.currentNoticeVersion ?? '1'}
              .
            </label>
            <button className="button full" type="submit" disabled={!accepted || pending}>
              {pending ? 'Saving...' : 'Accept and continue'}
            </button>
          </form>
        )}
        <Link to="/login">Back to sign in</Link>
      </div>
    </AccessLayout>
  );
}
export function SecurityScreen() {
  const { user, loading, refresh } = useSession();
  const [uri, setUri] = useState('');
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace />;
  async function enroll() {
    setPending(true);
    setError(undefined);
    try {
      const result = await api<{ otpauthUri: string }>('/auth/mfa/enroll', {
        method: 'POST',
        body: {},
      });
      setUri(result.otpauthUri);
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      const result = await api<{ recoveryCodes: string[] }>('/auth/mfa/confirm', {
        method: 'POST',
        body: { code },
      });
      setCodes(result.recoveryCodes);
      setUri('');
      setCode('');
      await refresh();
    } catch (error) {
      setError(error);
    } finally {
      setPending(false);
    }
  }
  let secret = '';
  try {
    secret = uri ? (new URL(uri).searchParams.get('secret') ?? '') : '';
  } catch {
    /* Display a server-provided setup value only when it is a valid URI. */
  }
  return (
    <AccessLayout>
      <div className="auth-card">
        <h1>Two-step verification</h1>
        <p className="muted">
          Admin, IT, Finance and Executive access requires an authenticator app.
        </p>
        <ErrorNotice error={error} />
        {codes.length ? (
          <>
            <div className="notice warning">
              <strong>Save your recovery codes now</strong>
              <p>
                Each code works once. Keep them in a secure password manager. They will not be shown
                again.
              </p>
              <pre className="recovery-codes">{codes.join('\n')}</pre>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={saved}
                onChange={(event) => setSaved(event.target.checked)}
              />
              I have saved these codes securely.
            </label>
            <ContinueLink disabled={!saved} />
          </>
        ) : user.mfaEnrolled && !user.mfaEnrollmentRequired ? (
          <div className="notice success">
            <strong>Authenticator enabled</strong>
            <p>Your account uses two-step verification.</p>
            <ContinueLink />
          </div>
        ) : uri ? (
          <form onSubmit={confirm}>
            <Field
              label="Setup key"
              htmlFor="mfa-secret"
              hint="In your authenticator app, add an account using a setup key, choose time based, then enter the current code below."
            >
              <input id="mfa-secret" value={secret} readOnly autoComplete="off" />
            </Field>
            <Field label="Authenticator code" htmlFor="mfa-code">
              <input
                id="mfa-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                pattern="[0-9]{6}"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
              />
            </Field>
            <button className="button full" disabled={pending}>
              {pending ? 'Verifying...' : 'Confirm authenticator'}
            </button>
          </form>
        ) : (
          <button type="button" className="button full" onClick={enroll} disabled={pending}>
            {pending ? 'Preparing...' : 'Set up authenticator'}
          </button>
        )}
        <p>
          <Link to="/profile">Back to account</Link>
        </p>
      </div>
    </AccessLayout>
  );
}
