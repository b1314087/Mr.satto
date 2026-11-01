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
