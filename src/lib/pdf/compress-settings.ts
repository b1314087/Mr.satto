/**
 * PDF圧縮の数値設定（画像の品質・画像の長辺の上限）と、プリセット・入力の確認・結果の計算。
 * 画面（pdf-compress-tool.tsx）と処理（pdf-image-recompress.ts）の両方から使う、DOMに依存しない部品。
 *
 * 数値で変えられるのは、PDFに埋め込まれたJPEG画像の
 *   - 品質（JPEGの品質。低いほどサイズが小さくなりやすく、画質は下がる）
 *   - 長辺の上限（画像の縦・横の長い方のピクセル数。超える画像だけを縮小する）
 * の2つだけ。圧縮率そのものは指定できない（PDFの中身しだいで、どれだけ小さくなるかは変わる）。
 */

export const IMAGE_QUALITY_MIN = 10;
export const IMAGE_QUALITY_MAX = 95;
export const MAX_EDGE_MIN = 300;
export const MAX_EDGE_MAX = 6000;

export interface PdfCompressSettings {
  /** 画像を再圧縮するか。false なら、これまでどおり構造の最適化だけを行う */
  recompressImages: boolean;
  /** JPEGの品質（10〜95の整数） */
  imageQuality: number;
  /** 画像の長辺の上限（px）。null は縮小しない */
  maxImageEdge: number | null;
}

export type PdfCompressPresetId = "structure" | "quality" | "standard" | "small";

export interface PdfCompressPreset {
  id: PdfCompressPresetId;
  label: string;
  description: string;
  settings: PdfCompressSettings;
}

/**
 * プリセット。どれも実際の設定値に対応する（ラベルだけのプリセットはない）。
 * 「標準」の値（品質75・長辺2000px）は、写真を含むPDFで、画面表示・A4印刷で目立つ劣化がなく、
 * サイズが十分に小さくなる組み合わせとして選んだ（報告書 docs/reports/stage18-pdf-compress-settings.md の実測を参照）。
 */
export const PDF_COMPRESS_PRESETS: readonly PdfCompressPreset[] = [
  {
    id: "quality",
    label: "高品質優先",
    description: "画質をほぼ保ちます。サイズの減り方は小さめです。",
    settings: { recompressImages: true, imageQuality: 85, maxImageEdge: 3000 },
  },
  {
    id: "standard",
    label: "標準",
    description: "画面で見る・A4で印刷するのに十分な画質で、サイズを小さくします。",
    settings: { recompressImages: true, imageQuality: 75, maxImageEdge: 2000 },
  },
  {
    id: "small",
    label: "サイズ削減優先",
    description: "画質を下げて、できるだけ小さくします。細かい文字の写真は読みにくくなる場合があります。",
    settings: { recompressImages: true, imageQuality: 50, maxImageEdge: 1200 },
  },
  {
    id: "structure",
    label: "画像はそのまま",
    description: "画像は変えず、PDFの内部の構造だけを整理します（これまでの圧縮と同じ）。",
    settings: { recompressImages: false, imageQuality: 75, maxImageEdge: 2000 },
  },
];

export const DEFAULT_PRESET_ID: PdfCompressPresetId = "standard";

export function getPreset(id: PdfCompressPresetId): PdfCompressPreset {
  return PDF_COMPRESS_PRESETS.find((p) => p.id === id)!;
}

export const DEFAULT_SETTINGS: PdfCompressSettings = getPreset(DEFAULT_PRESET_ID).settings;

/** 設定がプリセットのどれと同じか（どれとも違えば null＝自分で指定した値） */
export function matchPreset(settings: PdfCompressSettings): PdfCompressPresetId | null {
  const found = PDF_COMPRESS_PRESETS.find((p) =>
    p.settings.recompressImages === false
      ? settings.recompressImages === false
      : settings.recompressImages &&
        p.settings.imageQuality === settings.imageQuality &&
        p.settings.maxImageEdge === settings.maxImageEdge
  );
  return found ? found.id : null;
}

/**
 * 入力欄の文字を、整数として確かめる。問題があれば、次に何をすればよいかが分かるメッセージを返す。
 * 空欄・数値以外・小数・範囲外は、圧縮の処理へ渡さない。
 */
export function parseIntegerSetting(
  raw: string,
  min: number,
  max: number,
  label: string
): { ok: true; value: number } | { ok: false; message: string } {
  const text = raw.trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (text === "") return { ok: false, message: `${label}を入力してください（${min}〜${max}）。` };
  if (!/^-?\d+(\.\d+)?$/.test(text)) return { ok: false, message: `${label}は数字で入力してください（${min}〜${max}）。` };
  const value = Number(text);
  if (!Number.isInteger(value)) return { ok: false, message: `${label}は小数ではなく、整数で入力してください（${min}〜${max}）。` };
  if (value < min || value > max) return { ok: false, message: `${label}は${min}〜${max}の範囲で入力してください。` };
  return { ok: true, value };
}

/** 長辺の上限に収まるよう縮小した大きさ（縮小しない場合は元の大きさ）。縦横比は保つ */
export function fitWithinEdge(width: number, height: number, maxEdge: number | null): { width: number; height: number; resized: boolean } {
  const longest = Math.max(width, height);
  if (maxEdge === null || longest <= maxEdge) return { width, height, resized: false };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/** 圧縮前後のサイズから、削減したバイト数と削減率（%。増えた場合はマイナス）を計算する */
export function sizeReduction(originalBytes: number, compressedBytes: number): { savedBytes: number; percent: number } {
  const savedBytes = originalBytes - compressedBytes;
  const percent = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;
  return { savedBytes, percent };
}

// ---------------------------------------------------------------------------
// 目標のサイズ（MB）を指定する圧縮
// ---------------------------------------------------------------------------

/**
 * 目標のサイズの1MB。アップロードの上限（1MB＝1,000,000バイトの場合と、1,048,576バイトの場合がある）の
 * どちらにも確実に収まるよう、小さいほうの 1,000,000バイトで計算する。
 */
export const TARGET_MB_BYTES = 1_000_000;
export const TARGET_MB_MIN = 0.05;
export const TARGET_MB_MAX = 1000;

/** 目標のサイズの候補（ワンタップで入れられる値。元のPDFより小さいものだけを出す） */
export const TARGET_MB_CHOICES = [1, 2, 3, 5, 10] as const;

/**
 * 目標のサイズに近づけるときに試す設定の段階（上ほど画質を保ち、下ほど小さくなる）。
 * 画質（JPEGの品質）と画像の大きさ（長辺の上限）を、少しずつ同時に下げる。
 * 目標以下になる中で、いちばん上（画質がいちばん良い）段階を探す。
 */
export const TARGET_LADDER: readonly PdfCompressSettings[] = [
  { recompressImages: true, imageQuality: 85, maxImageEdge: 3000 },
  { recompressImages: true, imageQuality: 80, maxImageEdge: 2500 },
  { recompressImages: true, imageQuality: 75, maxImageEdge: 2000 },
  { recompressImages: true, imageQuality: 70, maxImageEdge: 1800 },
  { recompressImages: true, imageQuality: 65, maxImageEdge: 1600 },
  { recompressImages: true, imageQuality: 60, maxImageEdge: 1400 },
  { recompressImages: true, imageQuality: 55, maxImageEdge: 1200 },
  { recompressImages: true, imageQuality: 50, maxImageEdge: 1000 },
  { recompressImages: true, imageQuality: 45, maxImageEdge: 900 },
  { recompressImages: true, imageQuality: 40, maxImageEdge: 800 },
  { recompressImages: true, imageQuality: 35, maxImageEdge: 700 },
  { recompressImages: true, imageQuality: 30, maxImageEdge: 600 },
  { recompressImages: true, imageQuality: 25, maxImageEdge: 500 },
  { recompressImages: true, imageQuality: 20, maxImageEdge: 400 },
];

/** バイト数を、目標のサイズと同じ単位（1MB＝1,000,000バイト）のMBで表す */
export function bytesToTargetMB(bytes: number): number {
  return bytes / TARGET_MB_BYTES;
}

/** MBの表示（目標のサイズとの比較用。小数2けた） */
export function formatTargetMB(bytes: number): string {
  return `${bytesToTargetMB(bytes).toFixed(2)}MB`;
}

/**
 * 目標のサイズ（MB）の入力を確かめる。全角の数字・小数点も受け付ける。
 * 元のPDFがすでに目標以下のときは、圧縮しなくてよいことを伝える。
 */
export function parseTargetMB(raw: string, originalBytes: number | null): { ok: true; bytes: number; mb: number } | { ok: false; message: string } {
  const text = raw
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, ".")
    .replace(/\s*(mb|ＭＢ|MB|Mb)$/i, "");
  if (text === "") return { ok: false, message: "目標のサイズを、MBの数字で入力してください（例：2 や 1.5）。" };
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, message: "目標のサイズは、数字で入力してください（例：2 や 1.5）。" };
  const mb = Number(text);
  if (mb < TARGET_MB_MIN || mb > TARGET_MB_MAX) {
    return { ok: false, message: `目標のサイズは、${TARGET_MB_MIN}〜${TARGET_MB_MAX}MBの範囲で入力してください。` };
  }
  const bytes = Math.floor(mb * TARGET_MB_BYTES);
  if (originalBytes !== null && originalBytes <= 2 * TARGET_MB_MIN * TARGET_MB_BYTES && originalBytes <= bytes) {
    return {
      ok: false,
      message: `このPDF（${formatTargetMB(originalBytes)}）は、すでに十分小さいため、サイズの指定では圧縮できません。さらに小さくしたい場合は「画質を指定する（詳しい設定）」を選んでください。`,
    };
  }
  if (originalBytes !== null && originalBytes <= bytes) {
    return {
      ok: false,
      message: `元のPDF（${formatTargetMB(originalBytes)}）は、すでに${mb}MB以下です。圧縮しなくても、この条件を満たしています。もっと小さい値を入力してください。`,
    };
  }
  return { ok: true, bytes, mb };
}

/** 目標のサイズの初期値（元のサイズの半分。0.1MB以上なら0.1MB単位、それ未満は0.01MB単位で切り捨て。最小0.05MB） */
export function suggestTargetMB(originalBytes: number): string {
  const half = bytesToTargetMB(originalBytes) / 2;
  const rounded = half >= 0.1 ? Math.floor(half * 10) / 10 : Math.floor(half * 100) / 100;
  return String(Math.max(TARGET_MB_MIN, rounded));
}
