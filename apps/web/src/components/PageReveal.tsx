import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import gsap from 'gsap';
import { GooLoader } from './ui';

/** Longest we wait for a page's first data before showing it anyway. */
const MAX_WAIT_MS = 2000;
/** Only show the loader if the wait is longer than this; quicker pages open without one. */
const LOADER_DELAY_MS = 400;
/**
 * One full loader cycle (one dot opens into three and closes back to one), matching the 2s
 * animations in tailwind.css. Once shown, the loader always ends on a whole cycle, so it is
 * never cut off half-way.
 */
const LOADER_CYCLE_MS = 2000;
/** Data counts as settled once nothing has been loading for this long (child queries start late). */
const SETTLE_MS = 120;

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Queries that are fetching for the first time (no data yet). Background refreshes don't count. */
function firstLoads(client: ReturnType<typeof useQueryClient>) {
  return client
    .getQueryCache()
    .findAll({ type: 'active' })
    .filter((q) => q.state.status === 'pending' && q.state.fetchStatus === 'fetching').length;
}

/**
 * Opens each page as one piece instead of letting sections pop in as their data arrives:
 * the page stays hidden until its first data has loaded (a loader appears only if that takes
 * longer than 0.4s, and then always plays whole cycles), then sections slide up in sequence, chart bars grow and headline numbers count up.
 *
 * Only runs when the page (path) changes; filters and background refreshes update in place.
 * Every inline style GSAP adds is cleared afterwards, so nothing is left that could affect
 * layout or pop-overs. People who ask for reduced motion get the page without animation.
 */
export function PageReveal({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const client = useQueryClient();
  const box = useRef<HTMLDivElement>(null);
  const [waiting, setWaiting] = useState(true);
  const [showLoader, setShowLoader] = useState(false);

  // Hide the new page before it paints.
  useLayoutEffect(() => {
    if (!box.current) return;
    setWaiting(true);
    setShowLoader(false);
    gsap.killTweensOf(box.current.querySelectorAll('*'));
    gsap.set(box.current, { autoAlpha: 0 });
  }, [pathname]);

  // Wait for the page's first data, then reveal.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const started = performance.now();
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let loaderShownAt: number | null = null;
    const loaderTimer = setTimeout(() => {
      if (done) return;
      loaderShownAt = performance.now();
      setShowLoader(true);
    }, LOADER_DELAY_MS);

    const finish = () => {
      setShowLoader(false);
      setWaiting(false);
      animateIn(el);
    };
    const reveal = () => {
      if (done) return;
      done = true;
      clearTimeout(loaderTimer);
      clearTimeout(settleTimer);
      unsubscribe();
      if (loaderShownAt === null) return finish();
      // Let the loader finish the cycle it is in (back to a single dot) before the page shows.
      const into = (performance.now() - loaderShownAt) % LOADER_CYCLE_MS;
      finishTimer = setTimeout(finish, into === 0 ? 0 : LOADER_CYCLE_MS - into);
    };
    const check = () => {
      if (done) return;
      if (performance.now() - started >= MAX_WAIT_MS) return reveal();
      clearTimeout(settleTimer);
      if (firstLoads(client) === 0) settleTimer = setTimeout(() => firstLoads(client) === 0 && reveal(), SETTLE_MS);
    };
    const unsubscribe = client.getQueryCache().subscribe(check);
    const maxTimer = setTimeout(reveal, MAX_WAIT_MS);
    // Let the page mount its queries before the first check.
    const first = requestAnimationFrame(check);
    return () => {
      done = true;
      cancelAnimationFrame(first);
      clearTimeout(loaderTimer);
      clearTimeout(settleTimer);
      clearTimeout(maxTimer);
      clearTimeout(finishTimer);
      unsubscribe();
    };
  }, [pathname, client]);

  return (
    <div className="relative">
      {showLoader && waiting ? (
        <div className="absolute inset-x-0 top-0 z-10 flex min-h-[50vh] items-center justify-center" aria-hidden="true">
          <GooLoader size={110} />
        </div>
      ) : null}
      <div ref={box} aria-busy={waiting || undefined}>
        {children}
      </div>
    </div>
  );
}

/** The page's sections: its top-level blocks, looking one level in when a page wraps everything. */
function sections(root: HTMLElement): HTMLElement[] {
  let items = Array.from(root.children) as HTMLElement[];
  for (let depth = 0; depth < 3 && items.length === 1 && items[0].children.length; depth++)
    items = Array.from(items[0].children) as HTMLElement[];
  return items.filter((item) => item.offsetParent !== null || item.getClientRects().length > 0).slice(0, 14);
}

function animateIn(root: HTMLElement) {
  if (reducedMotion()) {
    gsap.set(root, { clearProps: 'opacity,visibility' });
    return;
  }
  const blocks = sections(root);
  const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  tl.set(root, { autoAlpha: 1 });
  tl.fromTo(
    blocks,
    { autoAlpha: 0, y: 18 },
    { autoAlpha: 1, y: 0, duration: 0.55, stagger: 0.07, clearProps: 'opacity,visibility,transform' },
  );
  tl.add(() => {
    gsap.set(root, { clearProps: 'opacity,visibility' });
  });

  const growX = root.querySelectorAll('[data-grow="x"]');
  const growY = root.querySelectorAll('[data-grow="y"]');
  const spin = root.querySelectorAll('[data-grow="spin"]');
  if (growX.length)
    tl.fromTo(growX, { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: 'power2.out', stagger: 0.025, clearProps: 'transform' }, 0.15);
  if (growY.length)
    tl.fromTo(growY, { scaleY: 0 }, { scaleY: 1, duration: 0.8, ease: 'power2.out', stagger: 0.02, clearProps: 'transform' }, 0.15);
  if (spin.length)
    tl.fromTo(
      spin,
      { rotation: -90, scale: 0.85, autoAlpha: 0, transformOrigin: '50% 50%' },
      { rotation: 0, scale: 1, autoAlpha: 1, duration: 0.9, ease: 'power2.out', clearProps: 'transform,opacity,visibility' },
      0.15,
    );

  // Whole numbers in headline tiles count up to their value.
  // The text node React rendered is edited in place (never replaced), and the count stops if
  // React changes the number meanwhile, so React's view of the page stays correct.
  root.querySelectorAll<HTMLElement>('[data-count]').forEach((el) => {
    const node = el.firstChild;
    if (el.childNodes.length !== 1 || !(node instanceof Text)) return;
    const text = node.nodeValue ?? '';
    if (!/^\d{1,3}(,\d{2,3})*$|^\d+$/.test(text.trim())) return;
    const target = Number(text.replaceAll(',', ''));
    if (!target) return;
    const counter = { n: 0 };
    let written = text;
    const tween: gsap.core.Tween = gsap.to(counter, {
      n: target,
      duration: 0.9,
      delay: 0.1,
      ease: 'power2.out',
      onUpdate: (): void => {
        if (node.nodeValue !== written) {
          tween.kill();
          return;
        }
        written = Math.round(counter.n).toLocaleString('en-IN');
        node.nodeValue = written;
      },
      onComplete: () => {
        if (node.nodeValue === written) node.nodeValue = text;
      },
    });
    written = '0';
    node.nodeValue = written;
  });
}
