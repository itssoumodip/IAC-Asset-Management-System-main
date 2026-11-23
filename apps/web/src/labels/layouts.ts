export type LayoutId =
  | 'A4_40'
  | 'A4_24'
  | 'A4_14'
  | 'THERMAL_50x25'
  | 'A4_SQ_38'
  | 'A4_SQ_50'
  | 'THERMAL_40x40'
  | 'THERMAL_50x50';
/** Rectangle: QR beside the text. Square: QR on top, text underneath. */
export type LabelShape = 'rect' | 'square';
export interface Layout {
  id: LayoutId;
  pageWidthMm: number;
  pageHeightMm: number;
  cols: number;
  rows: number;
  labelWidthMm: number;
  labelHeightMm: number;
  marginTopMm: number;
  marginLeftMm: number;
  gapXMm: number;
  gapYMm: number;
  /** Default (largest comfortable) QR size for this stock. */
  qrMm: number;
  shape: LabelShape;
}
export const LAYOUTS: Record<LayoutId, Layout> = {
  // Avery L7654-compatible small stickers.
  A4_40: {
    id: 'A4_40',
    pageWidthMm: 210,
    pageHeightMm: 297,
    cols: 4,
    rows: 10,
    labelWidthMm: 45.7,
    labelHeightMm: 25.4,
    marginTopMm: 21.5,
    marginLeftMm: 9.7,
    gapXMm: 2.6,
    gapYMm: 0,
    qrMm: 18,
    shape: 'rect',
  },
  A4_24: {
    id: 'A4_24',
    pageWidthMm: 210,
    pageHeightMm: 297,
    cols: 3,
    rows: 8,
    labelWidthMm: 63.5,
    labelHeightMm: 33.9,
    marginTopMm: 12.9,
    marginLeftMm: 7.2,
    gapXMm: 2.5,
    gapYMm: 0,
    // QR fills most of the 33.9 mm height while leaving room for the 13-character Asset ID.
    qrMm: 27,
    shape: 'rect',
  },
  A4_14: {
    id: 'A4_14',
    pageWidthMm: 210,
    pageHeightMm: 297,
    cols: 2,
    rows: 7,
    labelWidthMm: 99.1,
    labelHeightMm: 38.1,
    marginTopMm: 15.1,
    marginLeftMm: 4.7,
    gapXMm: 2.5,
    gapYMm: 0,
    qrMm: 33,
    shape: 'rect',
  },
  THERMAL_50x25: {
    id: 'THERMAL_50x25',
    pageWidthMm: 50,
    pageHeightMm: 25,
    cols: 1,
    rows: 1,
    labelWidthMm: 50,
    labelHeightMm: 25,
    marginTopMm: 0,
    marginLeftMm: 0,
    gapXMm: 0,
    gapYMm: 0,
    qrMm: 20,
    shape: 'rect',
  },
  // Square stickers: QR on top, Asset ID underneath.
  A4_SQ_38: {
    id: 'A4_SQ_38',
    pageWidthMm: 210,
    pageHeightMm: 297,
    cols: 5,
    rows: 7,
    labelWidthMm: 38,
    labelHeightMm: 38,
    marginTopMm: 15.5,
    marginLeftMm: 7.5,
    gapXMm: 1,
    gapYMm: 0,
    qrMm: 26,
    shape: 'square',
  },
  A4_SQ_50: {
    id: 'A4_SQ_50',
    pageWidthMm: 210,
    pageHeightMm: 297,
    cols: 4,
    rows: 5,
    labelWidthMm: 50,
    labelHeightMm: 50,
    marginTopMm: 23.5,
    marginLeftMm: 3.5,
    gapXMm: 1,
    gapYMm: 0,
    qrMm: 36,
    shape: 'square',
  },
  THERMAL_40x40: {
    id: 'THERMAL_40x40',
    pageWidthMm: 40,
    pageHeightMm: 40,
    cols: 1,
    rows: 1,
    labelWidthMm: 40,
    labelHeightMm: 40,
    marginTopMm: 0,
    marginLeftMm: 0,
    gapXMm: 0,
    gapYMm: 0,
    qrMm: 28,
    shape: 'square',
  },
  THERMAL_50x50: {
    id: 'THERMAL_50x50',
    pageWidthMm: 50,
    pageHeightMm: 50,
    cols: 1,
    rows: 1,
    labelWidthMm: 50,
    labelHeightMm: 50,
    marginTopMm: 0,
    marginLeftMm: 0,
    gapXMm: 0,
    gapYMm: 0,
    qrMm: 36,
    shape: 'square',
  },
};export function layoutPages<T>(items: T[], layout: Layout, startAt: number): (T | null)[][] {
  const perPage = layout.cols * layout.rows;
  const start = Math.min(Math.max(Math.trunc(startAt) || 1, 1), perPage);
  const cells: (T | null)[] = [...Array<null>(start - 1).fill(null), ...items];
  const pages: (T | null)[][] = [];
  for (let i = 0; i < cells.length; i += perPage) {
    const page = cells.slice(i, i + perPage);
    while (page.length < perPage) page.push(null);
    pages.push(page);
  }
  return pages;
}
/** What text goes on each label. */
export type LabelText = 'full' | 'code' | 'none';

/**
 * Largest QR that fits the label with the chosen text: beside the text on rectangles, above it
 * on squares (leaving room for the lines underneath).
 */
export function maxQrMm(layout: Layout, text: LabelText): number {
  const padding = 3;
  if (layout.shape === 'rect') {
    // With text, each stock's own size is the most that still leaves room for the full Asset ID;
    // QR only can use the whole label height.
    return text === 'none' ? Math.floor(layout.labelHeightMm - padding) : layout.qrMm;
  }
  const textBand = text === 'none' ? 0 : text === 'code' ? 5 : 9;
  return Math.floor(Math.min(layout.labelWidthMm - padding, layout.labelHeightMm - padding - textBand));
}

export function scanUrl(origin: string, assetCode: string): string {
  return `${origin}/a/${encodeURIComponent(assetCode)}`;
}
