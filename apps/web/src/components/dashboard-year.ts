import { useSearchParams } from 'react-router-dom';

const FY_PATTERN = /^(19|20)\d\d$/;

/** "2024" → "FY 2024-25". */
export const fyText = (fy: string) => `FY ${fy}-${String(Number(fy) + 1).slice(-2)}`;

/**
 * The dashboard's chosen financial year, kept in the address (?fy=2024) so the Overview, Spend
 * and Asset insights all follow it, and a refresh or shared link keeps it.
 */
export function useDashboardYear() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('fy') ?? '';
  const fy = FY_PATTERN.test(raw) ? raw : '';
  const setFy = (value: string) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value) next.set('fy', value);
        else next.delete('fy');
        return next;
      },
      { replace: true },
    );
  /** `path` (a catalog link) narrowed to the chosen year. */
  const withYear = (path: string) => {
    if (!fy) return path;
    const [base, query = ''] = path.split('?');
    const next = new URLSearchParams(query);
    next.set('fy', fy);
    return `${base}?${next}`;
  };
  return { fy, setFy, withYear };
}
