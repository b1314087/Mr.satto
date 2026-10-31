import type { HandoffFileKind } from "./types";

/**
 * 受け渡すファイルの種類を判別する（工程16）。拡張子だけでは決めず、ファイルの先頭のバイトも確かめる。
 * - PDF・PNG・JPG・WebP・GIF：先頭のバイト（シグネチャ）で決める。拡張子は見ない
 * - Excel・Word・PowerPoint・ZIP：中身はどれもZIP形式のため、ZIPのシグネチャを確かめたうえで拡張子で区別する
 * - CSV・TSV・テキスト・Markdown・JSON：拡張子で決め、先頭に0バイト（バイナリの印）がないことを確かめる
 * どれにも当てはまらなければ null（種類を問わないツールにだけ渡せる）。
 * 受け取ったツールは、これまでどおり自分の確認（形式・中身）を行う。ここでの判別は候補選びのためのもの。
 */

const HEAD_BYTES = 16;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

const ZIP_FAMILY: Record<string, HandoffFileKind> = { xlsx: "xlsx", docx: "docx", pptx: "pptx", zip: "zip" };
const TEXT_FAMILY: Record<string, HandoffFileKind> = { csv: "csv", tsv: "tsv", txt: "txt", md: "md", json: "json" };

/** 先頭のバイトとファイル名から判別する（テストしやすいよう、読み込みとは分けている） */
export function detectFileKindFromBytes(head: Uint8Array, name: string): HandoffFileKind | null {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) return "webp";
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38])) return "gif"; // GIF8

  const ext = extensionOf(name);
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04]) || startsWith(head, [0x50, 0x4b, 0x05, 0x06])) {
    return ZIP_FAMILY[ext] ?? null;
  }
  const textKind = TEXT_FAMILY[ext];
  if (textKind && !head.includes(0)) return textKind;
  return null;
}

/** ファイル（Blob）の先頭だけを読んで判別する。中身全体は読まない */
export async function detectFileKind(file: Blob, name: string): Promise<HandoffFileKind | null> {
  const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
  return detectFileKindFromBytes(head, name);
}
