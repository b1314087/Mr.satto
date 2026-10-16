import { getPdfjs, renderPageToCanvas, type PdfjsPage, type PositionedTextItem } from "./pdfjs-client";

/**
 * PDF→Word用に、PDFのページから「文字の見た目」(太字・斜体・色・リンク)と画像を取り出す。
 * すべてブラウザ内（pdfjs-dist と Canvas）で完結し、ファイルは外部へ送信しない。
 *
 * - フォント: ページのフォント情報（フォント名・太字/斜体の指定）から推定する。
 *   ※ Wordが「擬似太字」（文字の輪郭線を重ね描きして太く見せる方式）で出力した太字は
 *     フォント自体は通常の太さのため、判別できない。
 * - 色: ページを画像にして、各文字の範囲にある「文字の色」を読み取る（黒・暗い灰色は既定色として省略）。
 * - リンク: ページ上のリンク注釈の範囲に入る文字へURLを付ける。
 * - 画像: 描画命令から画像の位置と大きさを求め、ページ画像から切り出す
 *   （ページ全面を覆う背景画像・極端に小さい画像は除く）。
 */

type FontInfo = { bold: boolean; italic: boolean; serif: boolean; mono: boolean };

const BOLD_NAME_RE = /bold|black|heavy|demi|semibold|extrabold|[-_ ]w[6-9]\b|ゴシックb|太/i;
const ITALIC_NAME_RE = /italic|oblique|[-_,]it\b|斜/i;
const SERIF_NAME_RE = /mincho|明朝|serif|times|garamond|georgia|palatino|song|batang|cambria|century|ming|(^|[-_+ ])min([-_ ]|$)/i;
const MONO_NAME_RE = /courier|consolas|monospace|mono\b|lucida console|menlo/i;

/** ページのフォントごとの太字・斜体・明朝系・等幅の判定 */
export async function getFontStyles(page: PdfjsPage, fontNames: string[]): Promise<Map<string, FontInfo>> {
  const result = new Map<string, FontInfo>();
  try {
    // フォントはページの描画命令を取得した時点で読み込まれる
    await page.getOperatorList();
  } catch {
    return result;
  }
  const commonObjs = (page as unknown as {
    commonObjs: { has(id: string): boolean; get(id: string): unknown };
  }).commonObjs;
  for (const name of fontNames) {
    if (result.has(name)) continue;
    try {
      if (!commonObjs.has(name)) continue;
      const font = commonObjs.get(name) as {
        name?: string;
        bold?: boolean;
        italic?: boolean;
        black?: boolean;
        fallbackName?: string;
        isMonospace?: boolean;
        isSerifFont?: boolean;
      };
      const psName = String(font?.name ?? "");
      result.set(name, {
        bold: Boolean(font?.bold || font?.black || BOLD_NAME_RE.test(psName)),
        italic: Boolean(font?.italic || ITALIC_NAME_RE.test(psName)),
        serif: Boolean(font?.isSerifFont || font?.fallbackName === "serif" || SERIF_NAME_RE.test(psName)),
        mono: Boolean(font?.isMonospace || font?.fallbackName === "monospace" || MONO_NAME_RE.test(psName)),
      });
    } catch {
      // フォント情報が取れないものは既定（通常の太さ）として扱う
    }
  }
  return result;
}

/** 太字・斜体・明朝系・等幅の情報を、文字の項目へ付ける */
export async function attachFontStyles(page: PdfjsPage, items: PositionedTextItem[]): Promise<void> {
  const names = Array.from(new Set(items.map((i) => i.fontName).filter((n): n is string => !!n)));
  if (names.length === 0) return;
  const styles = await getFontStyles(page, names);
  for (const item of items) {
    const info = item.fontName ? styles.get(item.fontName) : undefined;
    if (!info) continue;
    if (info.bold) item.bold = true;
    if (info.italic) item.italic = true;
    if (info.serif) item.serif = true;
    if (info.mono) item.mono = true;
  }
}

/** ページ上のリンク（http/https/mailto）の範囲にある文字へ、URLを付ける */
export async function attachLinks(page: PdfjsPage, items: PositionedTextItem[]): Promise<void> {
  let annotations: unknown[];
  try {
    annotations = await page.getAnnotations();
  } catch {
    return;
  }
  const links: { url: string; rect: number[] }[] = [];
  for (const a of annotations as { subtype?: string; url?: string; unsafeUrl?: string; rect?: number[] }[]) {
    if (a.subtype !== "Link" || !a.rect) continue;
    const url = a.url ?? a.unsafeUrl;
    if (typeof url === "string" && /^(https?:\/\/|mailto:)/i.test(url)) links.push({ url, rect: a.rect });
  }
  if (links.length === 0) return;
  for (const item of items) {
    if (item.str.trim() === "") continue;
    const cx = item.x + item.width / 2;
    const cy = item.y + item.fontHeight * 0.3;
    const hit = links.find((l) => {
      const x1 = Math.min(l.rect[0], l.rect[2]);
      const x2 = Math.max(l.rect[0], l.rect[2]);
      const y1 = Math.min(l.rect[1], l.rect[3]);
      const y2 = Math.max(l.rect[1], l.rect[3]);
      return cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2;
    });
    if (hit) item.link = hit.url;
  }
}

function toHex(r: number, g: number, b: number): string {
  return [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/**
 * ページ画像から、各文字の範囲の「文字の色」を読み取って項目へ付ける。
 * 黒・暗い灰色は既定色なので付けない。背景が暗い（白抜き文字）場合も付けない
 * （Wordでは背景の塗りを再現しないため、白い文字は見えなくなる）。
 */
export function attachTextColors(
  canvas: HTMLCanvasElement,
  scale: number,
  page: PdfjsPage,
  items: PositionedTextItem[]
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let image: ImageData;
  try {
    image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    return;
  }
  const { data, width, height } = image;
  const viewport = page.getViewport({ scale });

  for (const item of items) {
    if (item.str.trim() === "" || item.width <= 0) continue;
    const [x0, yTop] = viewport.convertToViewportPoint(item.x, item.y + item.fontHeight * 0.85);
    const [x1, yBottom] = viewport.convertToViewportPoint(item.x + item.width, item.y - item.fontHeight * 0.15);
    const left = Math.max(0, Math.floor(Math.min(x0, x1)));
    const right = Math.min(width, Math.ceil(Math.max(x0, x1)));
    const top = Math.max(0, Math.floor(Math.min(yTop, yBottom)));
    const bottom = Math.min(height, Math.ceil(Math.max(yTop, yBottom)));
    if (right - left < 2 || bottom - top < 2) continue;

    // 範囲の背景色（最も多い色）を求める
    const buckets = new Map<number, number>();
    const stepX = Math.max(1, Math.floor((right - left) / 80));
    const stepY = Math.max(1, Math.floor((bottom - top) / 30));
    for (let y = top; y < bottom; y += stepY) {
      for (let x = left; x < right; x += stepX) {
        const i = (y * width + x) * 4;
        const key = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }
    }
    let bgKey = 0;
    let bgCount = -1;
    for (const [k, c] of buckets) {
      if (c > bgCount) {
        bgKey = k;
        bgCount = c;
      }
    }
    const bgR = ((bgKey >> 8) & 15) * 16 + 8;
    const bgG = ((bgKey >> 4) & 15) * 16 + 8;
    const bgB = (bgKey & 15) * 16 + 8;
    const bgLum = 0.299 * bgR + 0.587 * bgG + 0.114 * bgB;
    if (bgLum < 140) continue;

    // 背景から最も離れた画素（＝文字の中心に近い、濃い画素）の平均色を文字色とする
    const dist: { d: number; r: number; g: number; b: number }[] = [];
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const i = (y * width + x) * 4;
        const dr = data[i] - bgR;
        const dg = data[i + 1] - bgG;
        const db = data[i + 2] - bgB;
        const d = Math.abs(dr) + Math.abs(dg) + Math.abs(db);
        if (d > 90) dist.push({ d, r: data[i], g: data[i + 1], b: data[i + 2] });
      }
    }
    if (dist.length < 3) continue;
    dist.sort((a, b) => b.d - a.d);
    const take = dist.slice(0, Math.max(3, Math.ceil(dist.length * 0.25)));
    const r = take.reduce((s, p) => s + p.r, 0) / take.length;
    const g = take.reduce((s, p) => s + p.g, 0) / take.length;
    const b = take.reduce((s, p) => s + p.b, 0) / take.length;
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    // 黒・暗い灰色は既定色のまま（細い文字の縁のにじみで、灰色に見えることがあるため）
    if (chroma < 40 && lum < 90) continue;
    if (lum > 215) continue;
    item.color = toHex(r, g, b);
  }
}

// ---------------------------------------------------------------------------
// 画像
// ---------------------------------------------------------------------------

export interface ExtractedImage {
  /** PNGのバイト列 */
  data: Uint8Array;
  /** ページ座標での位置・大きさ(pt)。topは画像の上端のy座標 */
  x: number;
  top: number;
  width: number;
  height: number;
}

type Matrix = [number, number, number, number, number, number];

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

const MAX_IMAGES_PER_PAGE = 12;
const MIN_IMAGE_SIDE_PT = 14;
/** ページ全面を覆うような画像（背景・スキャン画像）はWordには入れない */
const MAX_PAGE_COVERAGE = 0.8;

/**
 * ページの描画命令から画像の置かれた範囲を求め、ページ画像（scale倍）から切り出す。
 * 回転したページ・拡大縮小が極端なものは対象外。
 */
export async function extractPageImages(
  page: PdfjsPage,
  rendered: { canvas: HTMLCanvasElement; scale: number }
): Promise<ExtractedImage[]> {
  const pdfjs = await getPdfjs();
  const OPS = pdfjs.OPS;
  const rotate = (page as unknown as { rotate?: number }).rotate ?? 0;
  if (rotate % 360 !== 0) return [];

  let opList: { fnArray: number[]; argsArray: unknown[] };
  try {
    opList = await page.getOperatorList();
  } catch {
    return [];
  }

  const view = page.view; // [x0, y0, x1, y1]
  const pageW = view[2] - view[0];
  const pageH = view[3] - view[1];
  const boxes: { x0: number; y0: number; x1: number; y1: number }[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];

  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i] as unknown;
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.transform) {
      ctm = multiply(ctm, args as Matrix);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = (args as unknown[])[0];
      if (Array.isArray(m) && m.length === 6) ctm = multiply(ctm, m as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (
      fn === OPS.paintImageXObject ||
      fn === OPS.paintInlineImageXObject ||
      fn === OPS.paintImageXObjectRepeat
    ) {
      const corners: [number, number][] = [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ].map(([u, v]) => [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]]);
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  }

  const seen = new Set<string>();
  const images: ExtractedImage[] = [];
  const viewport = page.getViewport({ scale: rendered.scale });
  for (const b of boxes) {
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    if (w < MIN_IMAGE_SIDE_PT || h < MIN_IMAGE_SIDE_PT) continue;
    if ((w * h) / (pageW * pageH) > MAX_PAGE_COVERAGE) continue;
    const key = [b.x0, b.y0, w, h].map((v) => Math.round(v)).join(",");
    if (seen.has(key)) continue;
    seen.add(key);

    const [px0, py0] = viewport.convertToViewportPoint(b.x0, b.y1);
    const [px1, py1] = viewport.convertToViewportPoint(b.x1, b.y0);
    const sx = Math.max(0, Math.floor(Math.min(px0, px1)));
    const sy = Math.max(0, Math.floor(Math.min(py0, py1)));
    const sw = Math.min(rendered.canvas.width - sx, Math.ceil(Math.abs(px1 - px0)));
    const sh = Math.min(rendered.canvas.height - sy, Math.ceil(Math.abs(py1 - py0)));
    if (sw < 4 || sh < 4) continue;

    const crop = document.createElement("canvas");
    crop.width = sw;
    crop.height = sh;
    const cctx = crop.getContext("2d");
    if (!cctx) continue;
    cctx.drawImage(rendered.canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    const blob: Blob | null = await new Promise((resolve) => crop.toBlob(resolve, "image/png"));
    if (!blob) continue;
    images.push({
      data: new Uint8Array(await blob.arrayBuffer()),
      x: b.x0 - view[0],
      top: b.y1,
      width: w,
      height: h,
    });
    if (images.length >= MAX_IMAGES_PER_PAGE) break;
  }
  return images;
}

/**
 * 文字の書式（フォント・リンク・色）と画像をまとめて取り出す。
 * 色と画像はページを画像にする必要があるため、不要な場合(プレビュー等)は withRender: false にする。
 */
export async function applyPageStyles(
  page: PdfjsPage,
  items: PositionedTextItem[],
  options: { withRender: boolean; withImages: boolean }
): Promise<ExtractedImage[]> {
  await attachFontStyles(page, items);
  await attachLinks(page, items);
  if (!options.withRender) return [];
  let rendered: { canvas: HTMLCanvasElement; scale: number };
  try {
    rendered = await renderPageToCanvas(page, 2, 2400);
  } catch {
    return [];
  }
  attachTextColors(rendered.canvas, rendered.scale, page, items);
  if (!options.withImages) return [];
  try {
    return await extractPageImages(page, rendered);
  } catch {
    return [];
  }
}
