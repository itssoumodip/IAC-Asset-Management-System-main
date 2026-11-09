import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { api } from '../api';
import { PageTitle, Panel, buttonClass, cx, noticeClass } from './ui';

type InstallPromptEvent = Event & { prompt(): Promise<void> };

let deferredInstallPrompt: InstallPromptEvent | null = null;

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredInstallPrompt = e as InstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
  });
}

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  if (!needRefresh) return null;
  return (
    <button
      type="button"
      role="status"
      className={cx(buttonClass(), 'fixed inset-x-4 bottom-48 z-50 mx-auto max-w-md shadow-lg')}
      onClick={() => void updateServiceWorker(true)}
    >
      New version available. Tap to reload.
    </button>
  );
}

export function InstallMenuItem({
  alwaysShow = false,
  onUnavailable,
  className,
}: {
  alwaysShow?: boolean;
  onUnavailable?: () => void;
  className?: string;
}) {
  const [event, setEvent] = useState<InstallPromptEvent | null>(deferredInstallPrompt);
  const [installed, setInstalled] = useState(isStandalone);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      const installEvent = e as InstallPromptEvent;
      deferredInstallPrompt = installEvent;
      setEvent(installEvent);
    };
    const onInstalled = () => {
      setEvent(null);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    // The global listener may have received the event before this page mounted.
    setEvent(deferredInstallPrompt);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  if (!event && !alwaysShow) return null;
  if (installed && alwaysShow)
    return (
      <p className={noticeClass('success')} role="status">
        IAC Assets is already installed on this device.
      </p>
    );
  return (
    <button
      type="button"
      className={`${alwaysShow ? 'button' : 'button text small'}${className ? ` ${className}` : ''}`}
      onClick={async () => {
        if (!event) {
          onUnavailable?.();
          return;
        }
        const pending = event;
        setEvent(null);
        deferredInstallPrompt = null;
        try {
          await pending.prompt();
        } catch {
          onUnavailable?.();
        }
      }}
    >
      Install app
    </button>
  );
}

function vapidBytes(value: string) {
  const padded = value.padEnd(value.length + ((4 - (value.length % 4)) % 4), '=');
  const base64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

function subscriptionUsesVapidKey(subscription: PushSubscription, expected: Uint8Array) {
  const current = subscription.options.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  return (
    bytes.length === expected.length && bytes.every((value, index) => value === expected[index])
  );
}

function withTimeout<T>(promise: Promise<T>, step: string, milliseconds = 20_000): Promise<T> {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = window.setTimeout(
        () => reject(new Error(`${step} is taking too long. Check your connection and retry.`)),
        milliseconds,
      );
    }),
  ]).finally(() => window.clearTimeout(timer));
}

function saveSubscriptionWithTimeout(subscription: PushSubscription) {
  const controller = new AbortController();
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      controller.abort();
      reject(new Error('Saving this device timed out. Check your connection and try again.'));
    }, 20_000);
  });
  return Promise.race([
    api('/push/subscription', {
      method: 'PUT',
      body: subscription.toJSON(),
      signal: controller.signal,
    }),
    timeout,
  ]).finally(() => window.clearTimeout(timer));
}

function installPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1))
    return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Windows/.test(ua)) return 'windows';
  return 'desktop';
}

export function InstallAppPage() {
  const [platform] = useState(installPlatform);
  const [pushSupported, setPushSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default');
  const [subscribed, setSubscribed] = useState(false);
  const [subscriptionNeedsRefresh, setSubscriptionNeedsRefresh] = useState(false);
  const [working, setWorking] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [installHint, setInstallHint] = useState('');

  useEffect(() => {
    const supported =
      window.isSecureContext &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window &&
      !(platform === 'ios' && !isStandalone());
    setPushSupported(supported);
    if (!('Notification' in window)) setPermission('unsupported');
    else setPermission(Notification.permission);
    if (supported) {
      void Promise.all([
        navigator.serviceWorker.ready,
        api<{ enabled: boolean; publicKey: string | null }>('/push/public-key'),
      ])
        .then(async ([registration, config]) => {
          const subscription = await registration.pushManager.getSubscription();
          const needsRefresh =
            !!subscription &&
            !!config.publicKey &&
            !subscriptionUsesVapidKey(subscription, vapidBytes(config.publicKey));
          setSubscriptionNeedsRefresh(needsRefresh);
          setSubscribed(!!subscription && !needsRefresh);
        })
        .catch(() => undefined);
    }
  }, []);

  async function enableNotifications() {
    setWorking('Checking notification settings…');
    setError('');
    setMessage('');
    try {
      // Request permission immediately from the click handler, before any network await.
      // Browsers require Notification.requestPermission() to be triggered by user action.
      let result = Notification.permission;
      if (result === 'default') {
        setWorking('Waiting for your browser permission…');
        result = await withTimeout(
          Notification.requestPermission(),
          'Waiting for notification permission',
          90_000,
        );
      }
      setPermission(result);
      if (result !== 'granted')
        throw new Error(
          result === 'denied'
            ? 'Notifications are blocked in your browser settings. Allow them for this site, then try again.'
            : 'Notification permission was not granted.',
        );
      setWorking('Checking notification settings…');
      const config = await withTimeout(
        api<{ enabled: boolean; publicKey: string | null }>('/push/public-key'),
        'Checking the server',
      );
      if (!config.enabled || !config.publicKey)
        throw new Error('Push notifications are not configured on this server yet.');
      setWorking('Preparing this device…');
      const registration = await withTimeout(
        navigator.serviceWorker.ready,
        'Preparing the app service worker',
      );
      let subscription = await withTimeout(
        registration.pushManager.getSubscription(),
        'Checking this device subscription',
      );
      const applicationServerKey = vapidBytes(config.publicKey);
      if (subscription && !subscriptionUsesVapidKey(subscription, applicationServerKey)) {
        setWorking('Refreshing this device’s notification key…');
        await withTimeout(
          api('/push/subscription', {
            method: 'DELETE',
            body: { endpoint: subscription.endpoint },
          }),
          'Removing the old device subscription',
        );
        await withTimeout(subscription.unsubscribe(), 'Refreshing the browser subscription');
        subscription = null;
      }
      if (!subscription) {
        setWorking('Connecting this device…');
        subscription = await withTimeout(
          registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }),
          'Connecting to the browser notification service',
          30_000,
        );
      }
      setWorking('Saving this device…');
      await saveSubscriptionWithTimeout(subscription);
      setSubscribed(true);
      setSubscriptionNeedsRefresh(false);
      setMessage('Notifications are enabled on this device.');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not enable notifications. Please retry.',
      );
    } finally {
      setWorking('');
    }
  }

  async function disableNotifications() {
    setWorking('Turning notifications off…');
    setError('');
    setMessage('');
    try {
      const registration = await withTimeout(
        navigator.serviceWorker.ready,
        'Preparing the app service worker',
      );
      const subscription = await withTimeout(
        registration.pushManager.getSubscription(),
        'Checking this device subscription',
      );
      if (subscription) {
        await withTimeout(
          api('/push/subscription', {
            method: 'DELETE',
            body: { endpoint: subscription.endpoint },
          }),
          'Removing the server subscription',
        );
        await subscription.unsubscribe();
      }
      setSubscribed(false);
      setMessage('Notifications are turned off on this device.');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Could not turn off notifications. Please retry.',
      );
    } finally {
      setWorking('');
    }
  }

  const installFallback: Record<string, string> = {
    ios: 'iOS requires Safari’s Share → Add to Home Screen action; Apple does not allow a website button to install a PWA directly.',
    mac: 'This browser did not offer a direct install prompt. In Safari, choose File → Add to Dock; in Chrome or Edge, use the browser menu’s Install option.',
    android:
      'This browser did not offer a direct install prompt. Open the browser menu and choose Install app or Add to Home screen.',
    windows:
      'This browser did not offer a direct install prompt. In Chrome or Edge, use the install icon or Install app option in the browser menu.',
    desktop:
      'This browser did not offer a direct install prompt. Check its menu for Install app or Add to Dock.',
  };

  return (
    <>
      <PageTitle
        title="Install IAC Assets"
        description="Install the portal as an app on this device."
      />
      <div className="install-guide-grid">
        <Panel title="App installation" className="install-guide-card">
          <InstallMenuItem
            alwaysShow
            onUnavailable={() => setInstallHint(installFallback[platform])}
          />
          {installHint ? (
            <p className="muted" role="status">
              {installHint}
            </p>
          ) : null}
          <p className="muted">
            Your browser will show its native install confirmation when available.
          </p>
        </Panel>
        <Panel title="Notifications on this device" className="install-guide-card">
          <p className="muted">
            Receive important asset and support announcements from your IT team. Your browser must
            allow notifications.
          </p>
          {!pushSupported ? (
            <p className={noticeClass('warning')}>
              Push notifications need a supported browser and a secure HTTPS connection. On iPhone
              or iPad, add this site to the Home Screen and open the installed app first.
            </p>
          ) : null}
          {pushSupported && permission === 'denied' ? (
            <p className={noticeClass('warning')}>
              Notifications are blocked in browser settings. Allow them for this site, then return
              here.
            </p>
          ) : null}
          {error ? (
            <p className={noticeClass('danger')} role="alert">
              {error}
            </p>
          ) : null}
          {message ? (
            <p className={noticeClass('success')} role="status">
              {message}
            </p>
          ) : null}
          {pushSupported ? (
            <button
              type="button"
              className={buttonClass()}
              disabled={!!working || permission === 'denied'}
              onClick={() => void (subscribed ? disableNotifications() : enableNotifications())}
            >
              {working ||
                (subscribed
                  ? 'Turn off notifications'
                  : subscriptionNeedsRefresh
                    ? 'Refresh notifications'
                    : 'Enable notifications')}
            </button>
          ) : null}
          {working ? (
            <p className="muted" role="status" aria-live="polite">
              {working}
            </p>
          ) : null}
          {pushSupported && permission === 'default' ? (
            <p className="muted">Your browser will ask for permission when you tap Enable.</p>
          ) : null}
        </Panel>
      </div>
      <p className="muted">
        Install this portal on each device where you want to receive announcements.
      </p>
    </>
  );
}

export function OfflineScreen() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  if (online) return null;
  return (
    <div
      role="alert"
      className="fixed inset-x-4 bottom-64 z-50 mx-auto max-w-md rounded-lg border border-sheet-edge bg-white p-6 text-center text-ink"
    >
      You&apos;re offline. Connect to the internet to scan or raise a ticket.
    </div>
  );
}
