/**
 * Office document → Markdown converter.
 *
 * Supports: .docx (Word), .xlsx/.xls/.csv (Excel), .pdf (PDF).
 * Output is intentionally minimal to save tokens:
 *   - No images, no base64, no inline styles
 *   - Tables use GFM pipe syntax
 *   - Excessive whitespace collapsed
 *
 * Libraries (all dynamically imported to keep the bundle clean):
 *   - mammoth           — .docx → HTML
 *   - turndown + GFM    — HTML → Markdown
 *   - xlsx (SheetJS)    — read spreadsheet cells
 *   - markdown-table    — array-of-arrays → GFM table
 *   - pdfjs-dist        — PDF text extraction
 */

/** Conversion options — all optional, sensible defaults applied. */
export interface ConvertOptions {
  /** Excel: max rows per sheet (default 200). */
  maxRows?: number;
  /** Excel: max columns per sheet (default 30). */
  maxCols?: number;
  /** Excel: truncate cell content longer than this (default 200 chars). */
  maxCellLength?: number;
  /** PDF: max pages to convert, 0 = all (default 0). */
  maxPages?: number;
}

const DEFAULTS: Required<ConvertOptions> = {
  maxRows: 200,
  maxCols: 30,
  maxCellLength: 200,
  maxPages: 0,
};

/** Supported file extensions (lowercase, no dot). */
export const SUPPORTED_EXTENSIONS = [
  'docx', 'xlsx', 'xls', 'xlsm', 'csv', 'pdf',
];

/** Returns true if the filename has a supported office-document extension. */
export function isSupportedFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * Convert an office document to minimal Markdown.
 *
 * @param data   File content (ArrayBuffer / Uint8Array / Buffer).
 * @param filename  Used to detect the format via extension.
 * @param options   Optional limits.
 * @returns Markdown string.
 * @throws Error for unsupported formats or conversion failures.
 */
export async function convertToMarkdown(
  data: ArrayBuffer | Uint8Array | Buffer,
  filename: string,
  options?: ConvertOptions,
): Promise<string> {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const opts = { ...DEFAULTS, ...options };

  // Normalise to a Uint8Array view (no copy when already Uint8Array/Buffer).
  const bytes = toUint8Array(data);

  let raw: string;
  switch (ext) {
    case 'docx':
      raw = await convertDocx(bytes);
      break;
    case 'xlsx':
    case 'xls':
    case 'xlsm':
    case 'csv':
      raw = await convertSpreadsheet(bytes, ext === 'csv', opts);
      break;
    case 'pdf':
      raw = await convertPdf(bytes, opts);
      break;
    default:
      throw new Error(`Unsupported file type: .${ext}. Supported: ${SUPPORTED_EXTENSIONS.map((e) => '.' + e).join(', ')}`);
  }

  return minimiseMarkdown(raw);
}

// ── Word (.docx) ────────────────────────────────────────────────────────────

async function convertDocx(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth');
  const TurndownService = (await import('turndown')).default;
  const gfmMod = await import('turndown-plugin-gfm');
  const gfm = gfmMod.gfm;

  // mammoth's Node input expects { buffer: Buffer }. We copy into a
  // standalone ArrayBuffer first (to avoid SharedArrayBuffer / byteOffset
  // issues with sliced views), then wrap it as a Buffer (zero-copy view).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(ab) });

  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
  });
  td.use(gfm);
  // Drop token-heavy elements we can't usefully represent as text.
  td.remove(['img', 'style', 'script', 'meta', 'link']);

  return td.turndown(result.value);
}

// ── Excel / CSV ─────────────────────────────────────────────────────────────

async function convertSpreadsheet(
  bytes: Uint8Array,
  isCsv: boolean,
  opts: Required<ConvertOptions>,
): Promise<string> {
  const XLSX = await import('xlsx');
  // markdown-table v3 uses a named export (`export function markdownTable`),
  // but some bundler/runtime combinations may wrap it under `.default`.
  const mt = await import('markdown-table') as unknown as {
    default?: { markdownTable?: (rows: unknown[]) => string } | ((rows: unknown[]) => string);
    markdownTable?: (rows: unknown[]) => string;
  };
  const markdownTable =
    (typeof mt.default === 'function' && mt.default) ||
    mt.default?.markdownTable ||
    mt.markdownTable ||
    (mt as unknown as (rows: unknown[]) => string);

  const wb = XLSX.read(bytes, { type: 'array', raw: false, cellDates: true });
  const parts: string[] = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet) continue;

    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: false,
    });

    if (rows.length === 0) continue;

    const truncated = rows.slice(0, opts.maxRows).map((row) => {
      const arr = (Array.isArray(row) ? row : [row]).slice(0, opts.maxCols).map((cell) => {
        let s = String(cell ?? '');
        // Collapse internal newlines that would break the table row.
        s = s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
        return s.length > opts.maxCellLength ? s.slice(0, opts.maxCellLength) + '…' : s;
      });
      return arr;
    });

    if (wb.SheetNames.length > 1 || !isCsv) {
      parts.push(`## ${sheetName}`);
    }
    parts.push(markdownTable(truncated));

    if (rows.length > opts.maxRows) {
      parts.push(`\n*…${rows.length - opts.maxRows} rows truncated*`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ── PDF ──────────────────────────────────────────────────────────────────────

async function convertPdf(bytes: Uint8Array, opts: Required<ConvertOptions>): Promise<string> {
  // Use the legacy build which works in Node without a DOM/canvas.
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  }).promise;

  const maxPages = opts.maxPages > 0 ? Math.min(opts.maxPages, doc.numPages) : doc.numPages;
  const pages: string[] = [];

  for (let i = 1; i <= maxPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();

    let pageText = '';
    let lastY: number | null = null;

    for (const item of content.items) {
      const str = 'str' in item ? (item as { str: string }).str : '';
      const transform = 'transform' in item ? (item as { transform: number[] }).transform : null;
      const y = transform ? transform[5] : null;
      const hasEOL = 'hasEOL' in item ? (item as { hasEOL: boolean }).hasEOL : false;

      // New line when the Y position changes significantly.
      if (lastY !== null && y !== null && Math.abs(lastY - y) > 2) {
        if (!pageText.endsWith('\n')) pageText += '\n';
      } else if (pageText && !pageText.endsWith(' ') && !pageText.endsWith('\n') && str) {
        pageText += ' ';
      }

      pageText += str;
      if (hasEOL && !pageText.endsWith('\n')) pageText += '\n';
      lastY = y;
    }

    pages.push(pageText.trim());
  }

  // Best-effort cleanup; destroy() exists at runtime but isn't in all type defs.
  await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
  return pages.join('\n\n');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toUint8Array(data: ArrayBuffer | Uint8Array | Buffer): Uint8Array {
  // Buffer extends Uint8Array, so this catches both Uint8Array and Buffer.
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/**
 * Collapse excessive whitespace to produce a token-efficient markdown string.
 * - Trailing whitespace per line removed.
 * - 3+ consecutive blank lines → 1 blank line.
 * - Leading/trailing whitespace trimmed.
 */
function minimiseMarkdown(md: string): string {
  return md
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
