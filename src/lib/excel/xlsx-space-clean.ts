import { unzipSync, zipSync, strFromU8, strToU8, type Zippable } from "fflate";

/**
 * Excelセル内の不要なスペース削除（総合改修 18）。
 *
 * ファイルの中身（XML）を直接書き換え、文字のセルの文字だけを変える。
 * - 変えるのは「文字のセル」だけ（共有文字列 t="s"・セル内の文字 t="inlineStr"）。
 *   数式のセル（<f>）・数値・日付・真偽値・エラーのセルは、いっさい変えない。
 * - 書式・列幅・結合セル・条件付き書式・グラフ・ほかの部分は、元のファイルのまま残す（XMLの該当部分だけを置き換える）。
 * - 選んだシートだけを処理するときも、ほかのシートの文字は変えない（同じ文字を使うほかのシートのために、
 *   変えた文字は共有文字列の末尾に新しく足し、処理したシートのセルだけがそれを指すようにする）。
 * - 元のファイルは変えず、新しいファイルを作る。
 */

export interface SpaceCleanOptions {
  /** 対象の空白の種類 */
  halfWidth: boolean;
  fullWidth: boolean;
  /** 先頭・末尾の空白を消す */
  leading: boolean;
  trailing: boolean;
  /** 文字と文字の間の空白：消さない／続いた空白を1つにする／すべて消す */
  middle: "keep" | "collapse" | "remove";
  /** 処理するシート（シートの並びの番号。空ならすべて） */
  sheetIndexes?: number[];
}

export const DEFAULT_SPACE_CLEAN: SpaceCleanOptions = { halfWidth: true, fullWidth: true, leading: true, trailing: true, middle: "collapse" };

/** 文字の空白を、指定どおりに整える（画面のプレビューと書き出しで共通） */
export function cleanSpaces(text: string, o: SpaceCleanOptions): string {
  const chars = [o.halfWidth ? " " : "", o.fullWidth ? "　" : ""].join("");
  if (chars === "") return text;
  const cls = `[${chars}]`;
  let s = text;
  // 改行ごとに処理する（セル内の改行は残す）
  s = s
    .split("\n")
    .map((line) => {
      let l = line;
      if (o.leading) l = l.replace(new RegExp(`^${cls}+`), "");
      if (o.trailing) l = l.replace(new RegExp(`${cls}+$`), "");
      if (o.middle !== "keep") {
        const lead = (l.match(new RegExp(`^${cls}+`)) ?? [""])[0];
        const trail = l.length > lead.length ? (l.match(new RegExp(`${cls}+$`)) ?? [""])[0] : "";
        const core = l.slice(lead.length, l.length - trail.length);
        const fixed = o.middle === "remove" ? core.replace(new RegExp(`${cls}+`, "g"), "") : core.replace(new RegExp(`${cls}{2,}`, "g"), (m) => m[0]);
        l = lead + fixed + trail;
      }
      return l;
    })
    .join("\n");
  return s;
}

export function spaceCleanOptionError(o: SpaceCleanOptions): string | null {
  if (!o.halfWidth && !o.fullWidth) return "消す空白の種類（半角・全角）を1つ以上選んでください。";
  if (!o.leading && !o.trailing && o.middle === "keep") return "消す場所（先頭・末尾・文字と文字の間）を1つ以上選んでください。";
  return null;
}

// ---------------------------------------------------------------------------
// XML の読み書き（必要な部分だけ）
// ---------------------------------------------------------------------------

const decodeXml = (s: string) =>
  s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e: string) =>
    e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? '"' : e === "apos" ? "'" : e.startsWith("#x") ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(parseInt(e.slice(1), 10))
  );
const encodeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** <t> の中身を書き換えた文字の要素（先頭・末尾の空白を保つため xml:space="preserve" を付ける） */
const tElement = (text: string) => (/^\s|\s$|　/.test(text) ? `<t xml:space="preserve">${encodeXml(text)}</t>` : `<t>${encodeXml(text)}</t>`);

interface StringItem {
  /** <si> の中身（元のXML） */
  inner: string;
}

/** <si> または <is> の中の文字（ふりがな <rPh> は除く） */
function textOfItem(inner: string): string {
  const noPh = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of noPh.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) out += decodeXml(m[1] ?? "");
  return out;
}

/**
 * <si>/<is> の中身を整える。文字のかたまり（<r> の書式つきの文字）が複数あるときは、
 * 先頭の空白は最初の文字の、末尾の空白は最後の文字のものとして扱い、文字と文字の間はそれぞれの中で整える
 * （書式の切れ目をまたぐ空白は、書式を壊さないため、そのままにする）。
 */
function cleanItem(inner: string, o: SpaceCleanOptions): string {
  const runs = [...inner.matchAll(/<r\b[\s\S]*?<\/r>/g)];
  if (runs.length === 0) {
    const text = textOfItem(inner);
    const next = cleanSpaces(text, o);
    if (next === text) return inner;
    const ph = inner.match(/<rPh\b[\s\S]*?<\/rPh>|<phoneticPr\b[^>]*\/>/g)?.join("") ?? "";
    return tElement(next) + ph;
  }
  let changed = false;
  let idx = 0;
  const out = inner.replace(/<r\b[\s\S]*?<\/r>/g, (run) => {
    const i = idx++;
    const t = run.match(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/);
    if (!t) return run;
    const text = decodeXml(t[1] ?? "");
    const opt: SpaceCleanOptions = { ...o, leading: o.leading && i === 0, trailing: o.trailing && i === runs.length - 1 };
    const next = cleanSpaces(text, opt);
    if (next === text) return run;
    changed = true;
    return run.replace(t[0], tElement(next));
  });
  return changed ? out : inner;
}

function sheetPaths(entries: Record<string, Uint8Array>): { name: string; path: string }[] {
  const wb = strFromU8(entries["xl/workbook.xml"] ?? new Uint8Array());
  const rels = strFromU8(entries["xl/_rels/workbook.xml.rels"] ?? new Uint8Array());
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const t = m[0].match(/\bTarget="([^"]+)"/)?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : `xl/${t.replace(/^\.\//, "")}`);
  }
  const out: { name: string; path: string }[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decodeXml(m[0].match(/\bname="([^"]*)"/)?.[1] ?? "");
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1] ?? m[0].match(/\bid="([^"]+)"/)?.[1];
    const p = rid ? target.get(rid) : undefined;
    if (p && entries[p]) out.push({ name, path: p });
  }
  return out;
}

export interface SpaceCleanChange {
  sheet: string;
  cell: string;
  before: string;
  after: string;
}

export interface SpaceCleanResult {
  blob?: Blob;
  sheets: { name: string; selected: boolean }[];
  /** 変えたセルの数 */
  changedCells: number;
  /** 変えたセルの例（先頭から最大 sampleMax 件） */
  samples: SpaceCleanChange[];
  /** 数式のセルなど、対象外として変えなかった文字のセルの数（数式の結果の文字） */
  skippedFormulaCells: number;
}

/**
 * Excelファイルの空白を整える。write=false のときは、変わるセルを数えるだけ（プレビュー用。ファイルは作らない）。
 */
export async function cleanXlsxSpaces(file: File | Blob, o: SpaceCleanOptions, opts: { write: boolean; sampleMax?: number } = { write: true }): Promise<SpaceCleanResult> {
  const problem = spaceCleanOptionError(o);
  if (problem) throw new Error(problem);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new Error("Excelファイル（.xlsx）として読み取れませんでした。ファイルが壊れていないか確かめてください。");
  }
  if (!entries["xl/workbook.xml"]) throw new Error("Excelファイル（.xlsx）として読み取れませんでした（ブックの情報がありません）。");
  const sheets = sheetPaths(entries);
  if (sheets.length === 0) throw new Error("シートが見つかりませんでした。");
  const selected = new Set(o.sheetIndexes && o.sheetIndexes.length > 0 ? o.sheetIndexes : sheets.map((_, i) => i));
  const sampleMax = opts.sampleMax ?? 50;

  // 共有文字列
  const sstPath = "xl/sharedStrings.xml";
  const sstXml = entries[sstPath] ? strFromU8(entries[sstPath]) : null;
  const items: StringItem[] = sstXml ? [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => ({ inner: m[1] ?? "" })) : [];
  const cleanedCache = new Map<number, string>();
  const added: string[] = [];
  const newIndexOf = new Map<number, number>();

  let changedCells = 0;
  let skippedFormulaCells = 0;
  const samples: SpaceCleanChange[] = [];
  const out: Zippable = {};

  sheets.forEach((sh, si) => {
    if (!selected.has(si)) return;
    const xml = strFromU8(entries[sh.path]);
    let sheetChanged = false;
    const next = xml.replace(/<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g, (whole, attrs: string, _end: string, body: string | undefined) => {
      if (!body) return whole;
      const type = attrs.match(/\bt="([^"]+)"/)?.[1];
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] ?? "";
      if (/<f\b/.test(body)) {
        if (type === "str") skippedFormulaCells++;
        return whole; // 数式のセルは変えない
      }
      if (type === "s") {
        const v = body.match(/<v>(\d+)<\/v>/);
        if (!v) return whole;
        const i = Number(v[1]);
        const item = items[i];
        if (!item) return whole;
        let cleaned = cleanedCache.get(i);
        if (cleaned === undefined) {
          cleaned = cleanItem(item.inner, o);
          cleanedCache.set(i, cleaned);
        }
        if (cleaned === item.inner) return whole;
        changedCells++;
        if (samples.length < sampleMax) samples.push({ sheet: sh.name, cell: ref, before: textOfItem(item.inner), after: textOfItem(cleaned) });
        let ni = newIndexOf.get(i);
        if (ni === undefined) {
          ni = items.length + added.length;
          added.push(cleaned);
          newIndexOf.set(i, ni);
        }
        sheetChanged = true;
        return whole.replace(v[0], `<v>${ni}</v>`);
      }
      if (type === "inlineStr") {
        const is = body.match(/<is>([\s\S]*?)<\/is>/);
        if (!is) return whole;
        const cleaned = cleanItem(is[1], o);
        if (cleaned === is[1]) return whole;
        changedCells++;
        if (samples.length < sampleMax) samples.push({ sheet: sh.name, cell: ref, before: textOfItem(is[1]), after: textOfItem(cleaned) });
        sheetChanged = true;
        return whole.replace(is[0], `<is>${cleaned}</is>`);
      }
      return whole; // 数値・日付・真偽値・エラーは変えない
    });
    if (sheetChanged) out[sh.path] = strToU8(next);
  });

  const result: SpaceCleanResult = { sheets: sheets.map((s, i) => ({ name: s.name, selected: selected.has(i) })), changedCells, samples, skippedFormulaCells };
  if (!opts.write) return result;

  if (added.length > 0 && sstXml) {
    const total = items.length + added.length;
    let sst = sstXml.replace(/<\/sst>\s*$/, `${added.map((a) => `<si>${a}</si>`).join("")}</sst>`);
    sst = sst.replace(/(<sst\b[^>]*?)\buniqueCount="\d+"/, `$1uniqueCount="${total}"`);
    out[sstPath] = strToU8(sst);
  }
  const zipped: Zippable = {};
  for (const [k, v] of Object.entries(entries)) zipped[k] = out[k] ?? v;
  const bytes = zipSync(zipped, { level: 6 });
  result.blob = new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  return result;
}

/** 空白を見える形にする（プレビュー用：半角＝␣、全角＝□） */
export function showSpaces(text: string): string {
  return text.replace(/ /g, "␣").replace(/　/g, "□");
}
