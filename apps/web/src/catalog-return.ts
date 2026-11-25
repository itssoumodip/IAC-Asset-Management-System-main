import { useLocation } from 'react-router-dom';

// The asset catalog's last search and filters (its URL query), kept for this browser tab so
// "← Asset catalog" and the sidebar link bring you back to the same list instead of a fresh one.
const KEY = 'iac.catalog.search';

export function rememberCatalogSearch(search: string) {
  try {
    if (search && search !== '?') sessionStorage.setItem(KEY, search);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage blocked: links simply open the catalog unfiltered.
  }
}

export function catalogHref() {
  try {
    const saved = sessionStorage.getItem(KEY);
    return saved ? `/assets${saved.startsWith('?') ? saved : `?${saved}`}` : '/assets';
  } catch {
    return '/assets';
  }
}

/** Same as catalogHref, re-read on every navigation so links stay current. */
export function useCatalogHref() {
  useLocation();
  return catalogHref();
}
