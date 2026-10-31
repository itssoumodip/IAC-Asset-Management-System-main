import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import type { Asset } from '../types';

interface PhotoResponse {
  dataUrl: string | null;
  updatedAt: string | null;
}

const imagePattern = /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/;

type Glyph = 'laptop' | 'monitor' | 'printer' | 'phone' | 'network' | 'furniture' | 'device';

/** Pick a recognisable silhouette from the asset's own wording. */
function glyphFor(asset: Asset): Glyph {
  const text = `${asset.assetType ?? ''} ${asset.category ?? ''} ${asset.description ?? ''}`
    .toLowerCase();
  if (/laptop|notebook|macbook|thinkpad/.test(text)) return 'laptop';
  if (/monitor|display|screen|projector|tv\b/.test(text)) return 'monitor';
  if (/printer|scanner|copier|fax/.test(text)) return 'printer';
  if (/phone|mobile|handset|tablet|ipad|sim\b/.test(text)) return 'phone';
  if (/router|switch|server|network|access point|firewall|nas\b/.test(text)) return 'network';
  if (/chair|desk|table|furniture|cabinet|shelf|sofa|rack/.test(text)) return 'furniture';
  return 'device';
}

function GlyphIcon({ kind }: { kind: Glyph }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {kind === 'laptop' ? (
        <>
          <rect x="4" y="5" width="16" height="10.5" rx="1.6" />
          <path d="M2.4 18.5h19.2" strokeLinecap="round" />
        </>
      ) : null}
      {kind === 'monitor' ? (
        <>
          <rect x="3" y="4.5" width="18" height="11.5" rx="1.6" />
          <path d="M12 16v3.5M8.5 19.5h7" strokeLinecap="round" />
        </>
      ) : null}
      {kind === 'printer' ? (
        <>
          <path d="M7 9V4.5h10V9" />
          <rect x="3.5" y="9" width="17" height="7" rx="1.6" />
          <path d="M7 14h10v5.5H7z" />
        </>
      ) : null}
      {kind === 'phone' ? (
        <>
          <rect x="7" y="2.5" width="10" height="19" rx="2.4" />
          <path d="M11 18.4h2" strokeLinecap="round" />
        </>
      ) : null}
      {kind === 'network' ? (
        <>
          <rect x="3" y="14" width="18" height="6" rx="1.6" />
          <path d="M7.5 14V9h9v5M12 9V4.5M8.5 4.5h7" />
        </>
      ) : null}
      {kind === 'furniture' ? (
        <>
          <path d="M6.5 10.5V7a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v3.5" />
          <path d="M4 10.5h16V16H4z" />
          <path d="M6.5 16v3.5M17.5 16v3.5" strokeLinecap="round" />
        </>
      ) : null}
      {kind === 'device' ? (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8.5 9h7M8.5 13h7M8.5 17h3.5" strokeLinecap="round" />
        </>
      ) : null}
    </svg>
  );
}

/**
 * Catalog thumbnail: the saved asset photo when there is one, otherwise a
 * product-type silhouette. Requests the photo only for assets the register says
 * have one, and shares the cache with the asset detail picture panel.
 */
export function AssetThumb({ asset }: { asset: Asset }) {
  const query = useQuery({
    queryKey: ['asset-photo', asset.id],
    queryFn: ({ signal }) => api<PhotoResponse>(`/assets/${asset.id}/photo`, { signal }),
    enabled: Boolean(asset.hasPhoto),
    staleTime: 5 * 60_000,
  });
  const photo = query.data?.dataUrl;
  const source = photo && imagePattern.test(photo) ? photo : undefined;
  return (
    <span className={source ? 'asset-thumb has-photo' : 'asset-thumb'} aria-hidden="true">
      {source ? (
        <img src={source} alt="" loading="lazy" decoding="async" />
      ) : (
        <GlyphIcon kind={glyphFor(asset)} />
      )}
    </span>
  );
}
