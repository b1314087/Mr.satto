/**
 * CSVの書き出しの文字コード（UTF-8 BOM付き・UTF-8 BOMなし・Shift_JIS／Windows-31J）。ブラウザ内だけで変換する。
 *
 * - 各ツールは、これまでどおり CSVの文字（またはUTF-8のCSVのBlob）を作り、ダウンロードのときだけ、ここで
 *   選んだ文字コードに変換する（CSVの作り方と、文字コードの変換を分ける）。
 * - Shift_JIS への変換：ブラウザの TextEncoder は UTF-8 しか作れないため、TextDecoder("shift_jis")
 *   （WHATWG Encoding 標準。Windows-31J＝CP932 と同じ対応表）で全部の2バイトを読み、逆引きの表を1回だけ作る。
 *   同じ文字に複数のバイト列がある場合は、Windows の変換と同じく「いちばん小さいバイト列」を使い、
 *   NEC選定IBM拡張文字（先頭のバイトが 0xED・0xEE）は使わない（WHATWG の Shift_JIS 変換と同じ規則）。
 *   例：№ → 0x8782（NEC特殊文字）、∵ → 0x81E6（JIS X 0208）、髙 → 0xFBFC（IBM拡張文字）。
 *   新しいライブラリは使わない（表はブラウザが持っている対応表から作る）。
 * - Shift_JIS で表せない文字（絵文字・一部の記号など）は、黙って消したり変えたりしない。書き出す前に見つけて
 *   （findUnencodable）、画面で利用者に確かめてもらう。そのまま書き出すときは「?」にする（Windows の変換と同じ）。
 *   見た目の近い文字がある文字（〜→～ など、Macで入力しがちな文字）は、利用者が選んだときだけ置き換える。
 */

export type CsvExportEncoding = "utf-8-bom" | "utf-8" | "shift_jis";

export const CSV_EXPORT_ENCODINGS: { value: CsvExportEncoding; label: string; hint: string }[] = [
  { value: "utf-8-bom", label: "UTF-8（BOM付き）", hint: "Excelで開くときにおすすめ" },
  { value: "utf-8", label: "UTF-8（BOMなし）", hint: "一般的なシステム連携向け" },
  { value: "shift_jis", label: "Shift_JIS／Windows-31J", hint: "銀行・会計ソフトなど、Shift_JIS指定のシステム向け" },
];

const BOM = "﻿";

// ---------------------------------------------------------------------------
// Windows-31J（CP932）の逆引き表
// ---------------------------------------------------------------------------

let encodeTable: Map<number, number> | null = null;

/** 文字（コードポイント）→ Shift_JIS のバイト列（1バイトは 0x00〜0xFF、2バイトは 先頭<<8 | 2バイト目） */
function getEncodeTable(): Map<number, number> {
  if (encodeTable) return encodeTable;
  const table = new Map<number, number>();
  const decoder = new TextDecoder("shift_jis");
  for (let b = 0x00; b <= 0x7f; b++) table.set(b, b);
  for (let b = 0xa1; b <= 0xdf; b++) {
    const s = decoder.decode(new Uint8Array([b]));
    if (s.length === 1 && s !== "�") table.set(s.charCodeAt(0), b);
  }
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead >= 0xa0 && lead <= 0xdf) continue;
    // NEC選定IBM拡張文字（0xED・0xEE）は、同じ文字がIBM拡張（0xFA〜0xFC）にあるため使わない
    if (lead === 0xed || lead === 0xee) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      pair[0] = lead;
      pair[1] = trail;
      const s = decoder.decode(pair);
      if (s.length !== 1 || s === "�") continue;
      const cp = s.charCodeAt(0);
      // 外字の領域（私用領域）は、環境ごとに字形が違うため書き出さない
      if (cp >= 0xe000 && cp <= 0xf8ff) continue;
      if (!table.has(cp)) table.set(cp, (lead << 8) | trail);
    }
  }
  encodeTable = table;
  return table;
}

/** Shift_JIS にない文字のうち、見た目の近い、Shift_JIS にある文字があるもの（利用者が選んだときだけ置き換える） */
export const SJIS_NEAR_REPLACEMENT: ReadonlyMap<number, string> = new Map([
  [0x301c, "～"], // 〜 波ダッシュ（Macで多い）→ 全角チルダ
  [0x2016, "∥"], // ‖ → 平行記号
  [0x2212, "－"], // − マイナス → 全角ハイフンマイナス
  [0x2014, "―"], // — エムダッシュ → 水平線
  [0x00a2, "￠"],
  [0x00a3, "￡"],
  [0x00ac, "￢"],
  [0x00a5, "￥"], // ¥ 半角の円記号 → 全角の円記号
  [0x203e, "￣"], // ‾ → 全角のオーバーライン
  [0x00a6, "￤"],
  [0x00a0, " "], // ノーブレークスペース → 半角スペース
]);

export interface UnencodableChar {
  char: string;
  codePoint: number;
  count: number;
  /** 最初に出てくる場所（CSVの行・列。1から） */
  row: number;
  column: number;
  /** 見た目の近い、Shift_JIS にある文字（あれば） */
  replacement: string | null;
}

/** 調べる文字の種類の上限（画面に出しきれないほど多いときは、ここで打ち切る） */
const MAX_DISTINCT = 50;

/**
 * CSVの文字の中から、Shift_JIS（Windows-31J）で表せない文字を見つける（行・列つき。引用符の中の改行・カンマも考える）。
 */
export function findUnencodable(csvText: string): UnencodableChar[] {
  const table = getEncodeTable();
  const found = new Map<number, UnencodableChar>();
  let row = 1;
  let column = 1;
  let inQuotes = false;
  const text = csvText.startsWith(BOM) ? csvText.slice(1) : csvText;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const ch = text.slice(i, i + len);
    if (ch === '"') {
      // "" は引用符そのもの。それ以外は引用の始まり・終わり
      if (inQuotes && text[i + 1] === '"') {
        i += 2;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === ",") {
      column++;
    } else if (!inQuotes && (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n"))) {
      row++;
      column = 1;
    } else if (!table.has(cp)) {
      const hit = found.get(cp);
      if (hit) hit.count++;
      else if (found.size < MAX_DISTINCT) found.set(cp, { char: ch, codePoint: cp, count: 1, row, column, replacement: SJIS_NEAR_REPLACEMENT.get(cp) ?? null });
    }
    i += len;
  }
  return [...found.values()];
}

/** CSVの文字を、Shift_JIS（Windows-31J）のバイト列にする。表せない文字は「?」、replaceNear のときは近い文字にする */
export function encodeShiftJis(text: string, options: { replaceNear?: boolean } = {}): Uint8Array {
  const table = getEncodeTable();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  const put = (code: number) => {
    if (code > 0xff) {
      out[n++] = code >> 8;
      out[n++] = code & 0xff;
    } else out[n++] = code;
  };
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    i += cp > 0xffff ? 2 : 1;
    if (cp === 0xfeff && n === 0) continue; // 先頭のBOMは書き出さない
    let code = table.get(cp);
    if (code === undefined && options.replaceNear) {
      const near = SJIS_NEAR_REPLACEMENT.get(cp);
      if (near !== undefined) code = table.get(near.codePointAt(0)!);
    }
    put(code ?? 0x3f);
  }
  return out.slice(0, n);
}

/** CSVの文字を、選んだ文字コードのBlobにする */
export function csvTextToBlob(csvText: string, encoding: CsvExportEncoding, options: { replaceNear?: boolean } = {}): Blob {
  const body = csvText.startsWith(BOM) ? csvText.slice(1) : csvText;
  if (encoding === "shift_jis") {
    return new Blob([encodeShiftJis(body, options) as BlobPart], { type: "text/csv;charset=shift_jis" });
  }
  return new Blob([encoding === "utf-8-bom" ? BOM + body : body], { type: "text/csv;charset=utf-8" });
}

/** ツールが作った UTF-8 のCSVのBlob（BOMの有無は問わない）から、文字を取り出す */
export async function csvBlobToText(blob: Blob): Promise<string> {
  const text = new TextDecoder("utf-8").decode(await blob.arrayBuffer());
  return text.startsWith(BOM) ? text.slice(1) : text;
}
