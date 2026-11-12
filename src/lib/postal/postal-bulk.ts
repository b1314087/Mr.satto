/**
 * 郵便番号・住所の一括処理（プレミアム機能）。
 * 貼り付けた一覧、またはExcel・CSVの列の値を1件ずつ調べ、郵便番号→住所、または住所→郵便番号の結果を返す。
 * 検索は1件のときと同じ（src/lib/postal/postal-search.ts）。ブラウザの中だけで行い、外部へは送らない。
 */
import { entryAddress, formatZip, normalizeZip, searchByAddress, searchByZip } from "./postal-search";

export type BulkDirection = "zip-to-address" | "address-to-zip";

export type BulkStatus = "ok" | "multiple" | "not-found" | "invalid" | "empty";

export const BULK_STATUS_LABEL: Record<BulkStatus, string> = {
  ok: "見つかりました",
  multiple: "候補が複数",
  "not-found": "見つかりません",
  invalid: "入力を確認",
  empty: "空欄",
};

export interface BulkRowResult {
  input: string;
  status: BulkStatus;
  /** 郵便番号→住所：住所。住所→郵便番号：郵便番号（123-4567）。候補が複数のときは先頭の候補 */
  value: string;
  /** 補足（候補の一覧・先頭の0を補ったことなど） */
  note: string;
}

/** 一度に調べられる件数の上限（ブラウザが重くならないように） */
export const BULK_MAX_ROWS = 10000;

const MAX_LISTED_CANDIDATES = 3;

async function lookupZip(input: string): Promise<BulkRowResult> {
  const raw = input.trim();
  if (raw === "") return { input, status: "empty", value: "", note: "" };
  let zip = normalizeZip(raw);
  let note = "";
  // Excelで数値として保存すると、北海道などの「0」で始まる郵便番号の先頭の0が消えて6けたになるため補う
  if (/^\d{6}$/.test(zip)) {
    zip = `0${zip}`;
    note = "先頭の0を補いました（Excelで数値として保存すると消えるため）。";
  }
  if (!/^\d{7}$/.test(zip)) return { input, status: "invalid", value: "", note: "郵便番号は7けたの数字で入れてください。" };
  const { results } = await searchByZip(zip);
  const exact = results.filter((r) => r.zip === zip);
  if (exact.length === 0) return { input, status: "not-found", value: "", note: note || "この郵便番号は見つかりませんでした。" };
  const addresses = [...new Set(exact.map(entryAddress))];
  if (addresses.length === 1) return { input, status: "ok", value: addresses[0], note };
  return {
    input,
    status: "multiple",
    value: addresses[0],
    note: `${note}候補が${addresses.length}件あります：${addresses.slice(0, MAX_LISTED_CANDIDATES).join("／")}${addresses.length > MAX_LISTED_CANDIDATES ? "／…" : ""}`,
  };
}

async function lookupAddress(input: string): Promise<BulkRowResult> {
  const raw = input.trim();
  if (raw === "") return { input, status: "empty", value: "", note: "" };
  let r: Awaited<ReturnType<typeof searchByAddress>>;
  try {
    r = await searchByAddress(null, raw);
  } catch (e) {
    return { input, status: "invalid", value: "", note: e instanceof Error ? e.message : "住所を確認してください。" };
  }
  const candidates = r.confidentZips.length > 0 ? r.results.filter((e) => r.confidentZips.includes(e.zip)) : r.results;
  const zips = [...new Set(candidates.map((e) => e.zip))].sort();
  if (zips.length === 0) return { input, status: "not-found", value: "", note: "この住所の郵便番号は見つかりませんでした。字を減らす（番地を外すなど）と見つかることがあります。" };
  if (zips.length === 1) return { input, status: "ok", value: formatZip(zips[0]), note: "" };
  // 同じ町域に、会社・役所などあての個別の郵便番号（会社名はデータに無い）が並ぶことがある。
  // 町域がすべて同じなら、番号の小さいもの（一般の郵便番号であることが多い）を入れ、ほかの番号は備考で知らせる
  const towns = new Set(candidates.map((e) => `${e.city}${e.town}`));
  if (towns.size === 1) {
    const others = zips.length - 1;
    return {
      input,
      status: "ok",
      value: formatZip(zips[0]),
      note: `同じ町域に、ほかに${others}件の郵便番号があります（会社・役所などあての個別の番号の場合があります）。ここでは番号の小さいものを入れています。`,
    };
  }
  return {
    input,
    status: "multiple",
    value: formatZip(zips[0]),
    note: `候補が${zips.length}件あります：${zips.slice(0, MAX_LISTED_CANDIDATES).map(formatZip).join("／")}${zips.length > MAX_LISTED_CANDIDATES ? "／…" : ""}（町域まで入れると絞り込めます）`,
  };
}

/**
 * まとめて調べる。onProgress には、調べ終わった件数を渡す。
 * 同じ入力は1回だけ調べる。画面が固まらないよう、少しずつ区切って処理する。
 */
export async function bulkLookup(
  inputs: string[],
  direction: BulkDirection,
  onProgress?: (done: number, total: number) => void
): Promise<BulkRowResult[]> {
  if (inputs.length > BULK_MAX_ROWS) throw new Error(`一度に調べられるのは${BULK_MAX_ROWS.toLocaleString("ja-JP")}件までです。分けて読み込んでください。`);
  const cache = new Map<string, BulkRowResult>();
  const out: BulkRowResult[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const key = inputs[i].trim();
    let r = cache.get(key);
    if (!r) {
      r = direction === "zip-to-address" ? await lookupZip(inputs[i]) : await lookupAddress(inputs[i]);
      cache.set(key, r);
    }
    out.push({ ...r, input: inputs[i] });
    if ((i + 1) % 200 === 0) {
      onProgress?.(i + 1, inputs.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.(inputs.length, inputs.length);
  return out;
}

/** 貼り付けた文字を、1行1件の一覧にする（末尾の空行は除く） */
export function linesFromText(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

/** 列の見出しから、郵便番号の列・住所の列を推測する */
export function guessColumns(headers: string[], direction: BulkDirection): number[] {
  const norm = headers.map((h) => h.normalize("NFKC").toLowerCase());
  if (direction === "zip-to-address") {
    const i = norm.findIndex((h) => /郵便|〒|zip|postal|ゆうびん/.test(h));
    return [i >= 0 ? i : 0];
  }
  const cols = norm.map((h, i) => (/住所|所在地|address|都道府県|市区町村|番地/.test(h) && !/郵便|メール|mail/.test(h) ? i : -1)).filter((i) => i >= 0);
  return cols.length > 0 ? cols : [0];
}

/** 結果の列の見出し */
export function resultHeaders(direction: BulkDirection): [string, string, string] {
  return direction === "zip-to-address" ? ["住所（検索結果）", "検索の状態", "備考"] : ["郵便番号（検索結果）", "検索の状態", "備考"];
}
