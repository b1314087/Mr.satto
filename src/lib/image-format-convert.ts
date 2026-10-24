/**
 * 画像形式変換（JPG・PNG・WebP）の共通ロジック（純粋な処理だけ。ブラウザ・通信に依存しない）。
 * JPG変換・PNG変換・WebP変換・画像一括変換の4つのページが、同じ画面部品（ImageFormatConvertTool）で使う。
 */
import { dedupeFileNames, stripExtension } from "@/lib/utils/format";

export type ConvertFormat = "image/jpeg" | "image/png" | "image/webp";

export const CONVERT_FORMATS: { value: ConvertFormat; label: string; ext: string }[] = [
  { value: "image/jpeg", label: "JPG", ext: "jpg" },
  { value: "image/png", label: "PNG", ext: "png" },
  { value: "image/webp", label: "WebP", ext: "webp" },
];

export function formatLabel(format: ConvertFormat): string {
  return CONVERT_FORMATS.find((f) => f.value === format)?.label ?? "";
}

export function formatExtension(format: ConvertFormat): string {
  return CONVERT_FORMATS.find((f) => f.value === format)?.ext ?? "jpg";
}

const MIME_BY_EXTENSION: Record<string, ConvertFormat> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

/**
 * ファイルが JPG / PNG / WebP のどれかを判定する（それ以外は null）。
 * MIMEタイプを優先し、空・不明なときだけ拡張子で補う。「image/jpg」「image/pjpeg」も JPG として扱う。
 */
export function detectConvertFormat(file: { name: string; type: string }): ConvertFormat | null {
  const type = (file.type || "").toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg" || type === "image/pjpeg") return "image/jpeg";
  if (type === "image/png" || type === "image/x-png") return "image/png";
  if (type === "image/webp") return "image/webp";
  if (type !== "" && type !== "application/octet-stream") return null;
  const dot = file.name.lastIndexOf(".");
  if (dot === -1) return null;
  return MIME_BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()] ?? null;
}

/** 変換しても意味がない（すでに出力形式と同じ）ファイルか */
export function isSameFormat(file: { name: string; type: string }, target: ConvertFormat): boolean {
  return detectConvertFormat(file) === target;
}

/** 変換の対象にするファイルと、すでに同じ形式のため変換しないファイルに分ける（順序は保つ） */
export function splitByFormat<T extends { name: string; type: string }>(files: T[], target: ConvertFormat): { convertible: T[]; sameFormat: T[] } {
  const convertible: T[] = [];
  const sameFormat: T[] = [];
  for (const f of files) (isSameFormat(f, target) ? sameFormat : convertible).push(f);
  return { convertible, sameFormat };
}

/** 出力ファイル名（元の名前の拡張子を、出力形式の拡張子にする）。同名になる場合は「_2」「_3」を付けて一意にする */
export function outputFileNames(sourceNames: string[], target: ConvertFormat): string[] {
  const ext = formatExtension(target);
  return dedupeFileNames(sourceNames.map((n) => `${stripExtension(n) || "image"}.${ext}`));
}

/** 変換結果の容量の増減（%）。元が0バイトなら null */
export function sizeChangePercent(beforeBytes: number, afterBytes: number): number | null {
  if (beforeBytes <= 0) return null;
  return Math.round(((afterBytes - beforeBytes) / beforeBytes) * 100);
}

/** 透過のある形式（PNG・WebP・不明）から JPG にするとき、透過部分が白になる */
export function transparencyNote(source: ConvertFormat | null, target: ConvertFormat): boolean {
  return target === "image/jpeg" && source !== "image/jpeg";
}
