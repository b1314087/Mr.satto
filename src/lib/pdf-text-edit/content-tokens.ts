/**
 * PDFのページの「描く命令」（コンテンツストリーム）を、ひとかたまりずつに分ける（2026-11-18 文字を消す機能）。
 *
 * コンテンツストリームは「値 値 … 命令」の並び（例：`BT /F1 12 Tf 72 700 Td (Hello) Tj ET`）。
 * 値（数・名前・文字列・配列・辞書）と命令に分け、元のバイトのどこにあったか（start〜end）を持つ。
 * 書き換えるときは、変えたい命令の部分だけを差し替え、それ以外のバイトはそのまま残す。
 *
 * 画像をページの中に直接書く命令（BI … ID ＜画像のデータ＞ EI）は、データの中身を読まずに丸ごと1つの命令として扱う。
 */

export type ContentValue =
  | { kind: "number"; value: number; start: number; end: number }
  | { kind: "name"; value: string; start: number; end: number }
  /** 文字列。bytes は、エスケープ（\n や \053 など）を戻した中身のバイト */
  | { kind: "string"; bytes: Uint8Array; hex: boolean; start: number; end: number }
  | { kind: "array"; items: ContentValue[]; start: number; end: number }
  | { kind: "dict"; entries: { key: string; value: ContentValue }[]; start: number; end: number }
  | { kind: "bool"; value: boolean; start: number; end: number }
  | { kind: "null"; start: number; end: number };

export interface ContentOperation {
  /** 命令の名前（Tj・TJ・cm など） */
  operator: string;
  operands: ContentValue[];
  /** この命令の値の先頭から、命令の名前の終わりまでの位置（元のバイトの中） */
  start: number;
  end: number;
}

export class ContentParseError extends Error {}

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isRegular(c: number): boolean {
  return !WHITESPACE.has(c) && !DELIMITERS.has(c);
}

/** コンテンツストリームのバイトを、命令の並びにする */
export function parseContentStream(bytes: Uint8Array): ContentOperation[] {
  const ops: ContentOperation[] = [];
  let pos = 0;
  const n = bytes.length;
  let operands: ContentValue[] = [];
  let opStart = -1;

  const skipSpace = () => {
    while (pos < n) {
      const c = bytes[pos];
      if (WHITESPACE.has(c)) pos++;
      else if (c === 0x25) {
        // % から行末まではコメント
        while (pos < n && bytes[pos] !== 0x0a && bytes[pos] !== 0x0d) pos++;
      } else break;
    }
  };

  const readLiteralString = (): ContentValue => {
    const start = pos;
    pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (pos < n) {
      const c = bytes[pos++];
      if (c === 0x5c) {
        // バックスラッシュ（エスケープ）
        if (pos >= n) break;
        const e = bytes[pos++];
        if (e === 0x6e) out.push(0x0a);
        else if (e === 0x72) out.push(0x0d);
        else if (e === 0x74) out.push(0x09);
        else if (e === 0x62) out.push(0x08);
        else if (e === 0x66) out.push(0x0c);
        else if (e === 0x0d) {
          if (bytes[pos] === 0x0a) pos++;
        } else if (e === 0x0a) {
          // 行の続き（何も入れない）
        } else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && pos < n && bytes[pos] >= 0x30 && bytes[pos] <= 0x37; k++) v = v * 8 + (bytes[pos++] - 0x30);
          out.push(v & 0xff);
        } else out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        depth--;
        if (depth === 0) return { kind: "string", bytes: Uint8Array.from(out), hex: false, start, end: pos };
        out.push(c);
      } else out.push(c);
    }
    throw new ContentParseError("文字列が閉じていません");
  };

  const readHexString = (): ContentValue => {
    const start = pos;
    pos++; // <
    const digits: number[] = [];
    while (pos < n && bytes[pos] !== 0x3e) {
      const c = bytes[pos++];
      if (WHITESPACE.has(c)) continue;
      const v = c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 0x37 : c >= 0x61 && c <= 0x66 ? c - 0x57 : -1;
      if (v < 0) throw new ContentParseError("16進の文字列に使えない文字があります");
      digits.push(v);
    }
    if (pos >= n) throw new ContentParseError("16進の文字列が閉じていません");
    pos++; // >
    if (digits.length % 2 === 1) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = digits[i * 2] * 16 + digits[i * 2 + 1];
    return { kind: "string", bytes: out, hex: true, start, end: pos };
  };

  const readName = (): ContentValue => {
    const start = pos;
    pos++; // /
    let s = "";
    while (pos < n && isRegular(bytes[pos])) {
      const c = bytes[pos++];
      if (c === 0x23 && pos + 1 < n) {
        const hex = String.fromCharCode(bytes[pos], bytes[pos + 1]);
        const v = parseInt(hex, 16);
        if (!Number.isNaN(v)) {
          s += String.fromCharCode(v);
          pos += 2;
          continue;
        }
      }
      s += String.fromCharCode(c);
    }
    return { kind: "name", value: s, start, end: pos };
  };

  const readValue = (): ContentValue | { keyword: string; start: number; end: number } => {
    skipSpace();
    if (pos >= n) throw new ContentParseError("途中で終わっています");
    const c = bytes[pos];
    if (c === 0x28) return readLiteralString();
    if (c === 0x3c) {
      if (bytes[pos + 1] === 0x3c) return readDict();
      return readHexString();
    }
    if (c === 0x2f) return readName();
    if (c === 0x5b) return readArray();
    if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      // 場違いな区切り文字は、1文字の命令として扱い、上の読み取りで捨てる
      const start = pos;
      pos++;
      return { keyword: String.fromCharCode(c), start, end: pos };
    }
    const start = pos;
    while (pos < n && isRegular(bytes[pos])) pos++;
    const word = new TextDecoder("latin1").decode(bytes.subarray(start, pos));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { kind: "number", value: Number(word), start, end: pos };
    if (word === "true" || word === "false") return { kind: "bool", value: word === "true", start, end: pos };
    if (word === "null") return { kind: "null", start, end: pos };
    return { keyword: word, start, end: pos };
  };

  function readArray(): ContentValue {
    const start = pos;
    pos++; // [
    const items: ContentValue[] = [];
    for (;;) {
      skipSpace();
      if (pos >= n) throw new ContentParseError("配列が閉じていません");
      if (bytes[pos] === 0x5d) {
        pos++;
        return { kind: "array", items, start, end: pos };
      }
      const v = readValue();
      if ("keyword" in v) continue; // 配列の中の知らない語は無視する
      items.push(v);
    }
  }

  function readDict(): ContentValue {
    const start = pos;
    pos += 2; // <<
    const entries: { key: string; value: ContentValue }[] = [];
    for (;;) {
      skipSpace();
      if (pos >= n) throw new ContentParseError("辞書が閉じていません");
      if (bytes[pos] === 0x3e && bytes[pos + 1] === 0x3e) {
        pos += 2;
        return { kind: "dict", entries, start, end: pos };
      }
      const k = readValue();
      if ("keyword" in k || k.kind !== "name") continue;
      const v = readValue();
      if ("keyword" in v) continue;
      entries.push({ key: k.value, value: v });
    }
  }

  for (;;) {
    skipSpace();
    if (pos >= n) break;
    const v = readValue();
    if (!("keyword" in v)) {
      if (opStart < 0) opStart = v.start;
      operands.push(v);
      continue;
    }
    const start = opStart < 0 ? v.start : opStart;
    if (v.keyword === "BI") {
      // 画像を直接書く命令：ID のあとの画像のデータを読まずに、EI（前後が空白）まで飛ばす
      const idAt = findKeyword(bytes, v.end, "ID");
      if (idAt < 0) throw new ContentParseError("BI のあとに ID がありません");
      let p = idAt + 2;
      if (WHITESPACE.has(bytes[p])) p++;
      let eiAt = -1;
      for (let q = p; q + 1 < n; q++) {
        if (bytes[q] === 0x45 && bytes[q + 1] === 0x49 && WHITESPACE.has(bytes[q - 1]) && (q + 2 >= n || WHITESPACE.has(bytes[q + 2]) || DELIMITERS.has(bytes[q + 2]))) {
          eiAt = q;
          break;
        }
      }
      if (eiAt < 0) throw new ContentParseError("BI のあとに EI がありません");
      pos = eiAt + 2;
      ops.push({ operator: "BI", operands: [], start, end: pos });
    } else {
      ops.push({ operator: v.keyword, operands, start, end: v.end });
    }
    operands = [];
    opStart = -1;
  }
  return ops;
}

function findKeyword(bytes: Uint8Array, from: number, word: string): number {
  const a = word.charCodeAt(0);
  const b = word.charCodeAt(1);
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] === a && bytes[i + 1] === b && (i === 0 || WHITESPACE.has(bytes[i - 1])) && (i + 2 >= bytes.length || WHITESPACE.has(bytes[i + 2]))) return i;
  }
  return -1;
}

/** 値を、コンテンツストリームに書ける形の文字に戻す（文字列は、安全な16進で書く） */
export function serializeValue(v: ContentValue): string {
  switch (v.kind) {
    case "number":
      return formatNumber(v.value);
    case "name":
      return "/" + [...v.value].map((ch) => (/[A-Za-z0-9._+-]/.test(ch) ? ch : "#" + ch.charCodeAt(0).toString(16).padStart(2, "0"))).join("");
    case "string":
      return hexString(v.bytes);
    case "array":
      return "[" + v.items.map(serializeValue).join(" ") + "]";
    case "dict":
      return "<<" + v.entries.map((e) => serializeValue({ kind: "name", value: e.key, start: 0, end: 0 }) + " " + serializeValue(e.value)).join(" ") + ">>";
    case "bool":
      return v.value ? "true" : "false";
    case "null":
      return "null";
  }
}

export function hexString(bytes: Uint8Array): string {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s + ">";
}

export function formatNumber(x: number): string {
  if (!Number.isFinite(x)) return "0";
  const r = Math.round(x * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}
