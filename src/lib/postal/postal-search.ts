/**
 * 郵便番号・住所検索（総合改修 17）。
 *
 * 住所データ（public/postal/）を、利用者のブラウザが自分のサイトから読み込み、ブラウザの中で検索する。
 * 入力した郵便番号・住所は、外部のサービスへ送らない（外部APIは使わない）。
 * データは日本郵便「郵便番号データ」（著作権を主張せず自由配布可）を、scripts/build-postal-data.mjs で整えたもの。
 */

export const PREFECTURES: { code: number; name: string }[] = [
  "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県", "茨城県", "栃木県", "群馬県",
  "埼玉県", "千葉県", "東京都", "神奈川県", "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県", "徳島県", "香川県", "愛媛県", "高知県", "福岡県",
  "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
].map((name, i) => ({ code: i + 1, name }));

export interface PostalEntry {
  /** 7桁の郵便番号（ハイフンなし） */
  zip: string;
  prefCode: number;
  pref: string;
  city: string;
  town: string;
}

interface PostalIndex {
  updated: string;
  source: string;
  count: number;
  prefixes: Record<string, number[]>;
}

/** 検索結果の上限（多すぎると画面が重くなるため） */
export const POSTAL_RESULT_MAX = 100;

const base = "/postal";
let indexPromise: Promise<PostalIndex> | null = null;
const prefCache = new Map<number, Promise<[string, string, string][]>>();

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) throw new Error("住所データを読み込めませんでした。通信の状態を確かめて、もう一度お試しください。");
  return (await res.json()) as T;
}

export function loadPostalIndex(): Promise<PostalIndex> {
  if (!indexPromise) {
    indexPromise = fetchJson<PostalIndex>(`${base}/index.json`).catch((e) => {
      indexPromise = null;
      throw e;
    });
  }
  return indexPromise;
}

function loadPref(code: number): Promise<[string, string, string][]> {
  let p = prefCache.get(code);
  if (!p) {
    p = fetchJson<[string, string, string][]>(`${base}/pref-${String(code).padStart(2, "0")}.json`).catch((e) => {
      prefCache.delete(code);
      throw e;
    });
    prefCache.set(code, p);
  }
  return p;
}

const toEntry = (code: number, r: [string, string, string]): PostalEntry => ({ zip: r[0], prefCode: code, pref: PREFECTURES[code - 1].name, city: r[1], town: r[2] });

/** 郵便番号の入力を、数字だけにする（全角・ハイフン・〒・空白を取り除く） */
export function normalizeZip(input: string): string {
  return input.normalize("NFKC").replace(/[〒\s\-ー－‐―]/g, "");
}

/** 郵便番号を 123-4567 の形にする */
export function formatZip(zip: string): string {
  return zip.length === 7 ? `${zip.slice(0, 3)}-${zip.slice(3)}` : zip;
}

/** 住所の表記ゆれをそろえる（全角・半角、空白、「ヶ」「ケ」「が」、数字の書き方） */
export function normalizeAddress(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[ヶケヵ]/g, "が")
    .replace(/[‐―－ー−]/g, "-")
    .replace(/之/g, "の");
}

/** 郵便番号の入力の確認。問題があれば理由を返す */
export function zipInputError(input: string): string | null {
  const z = normalizeZip(input);
  if (z === "") return "郵便番号を入れてください。";
  if (!/^\d+$/.test(z)) return "郵便番号は数字で入れてください（例：100-0001）。";
  if (z.length < 3) return "郵便番号は3桁以上入れてください（上3桁だけでも探せます）。";
  if (z.length > 7) return "郵便番号は7桁です。";
  return null;
}

/**
 * 郵便番号から住所を探す。7桁なら一致するもの、3〜6桁なら、その数字で始まるものを返す。
 */
export async function searchByZip(input: string): Promise<{ results: PostalEntry[]; truncated: boolean }> {
  const problem = zipInputError(input);
  if (problem) throw new Error(problem);
  const z = normalizeZip(input);
  const index = await loadPostalIndex();
  const prefs = index.prefixes[z.slice(0, 3)] ?? [];
  const results: PostalEntry[] = [];
  let total = 0;
  for (const code of prefs) {
    const rows = await loadPref(code);
    for (const r of rows) {
      if (r[0].startsWith(z)) {
        total++;
        if (results.length < POSTAL_RESULT_MAX) results.push(toEntry(code, r));
      }
    }
  }
  results.sort((a, b) => (a.zip < b.zip ? -1 : a.zip > b.zip ? 1 : 0));
  return { results, truncated: total > results.length };
}

/** 住所の先頭の都道府県名を見つける（「東京都千代田区…」→ 東京都） */
export function detectPrefecture(text: string): { code: number; rest: string } | null {
  const t = text.normalize("NFKC").replace(/\s+/g, "");
  for (const p of PREFECTURES) {
    if (t.startsWith(p.name)) return { code: p.code, rest: t.slice(p.name.length) };
    const short = p.name.replace(/[都府県]$/, "");
    if (p.name !== "北海道" && short.length >= 2 && t.startsWith(short)) {
      // 「京都市…」「大阪市…」のように、都道府県名の後に「市」が続くときは、市の名前の一部なので残す
      return { code: p.code, rest: t.startsWith(`${short}市`) ? t : t.slice(short.length) };
    }
  }
  return null;
}

/**
 * 住所から郵便番号を探す。
 * - 都道府県は、選ぶか、住所の先頭に書く（「東京都千代田区丸の内」など）。
 * - 市区町村・町域のどちらかに入力が含まれるもの、または入力が「市区町村＋町域」で始まるもの（番地まで入れた場合）を返す。
 *   「市区町村＋町域」が長く一致するものから順に並べる。
 */
export async function searchByAddress(
  prefCode: number | null,
  query: string
): Promise<{ results: PostalEntry[]; truncated: boolean; prefCode: number }> {
  let code = prefCode;
  let rest = query;
  const detected = detectPrefecture(query);
  if (detected) {
    code = detected.code;
    rest = detected.rest;
  }
  if (!code) throw new Error("都道府県を選ぶか、住所の先頭に都道府県名を入れてください。");
  const q = normalizeAddress(rest);
  if (q === "") throw new Error("市区町村・町域などの住所を入れてください。");
  const rows = await loadPref(code);
  const scored: { e: PostalEntry; score: number }[] = [];
  for (const r of rows) {
    const key = normalizeAddress(r[1] + r[2]);
    const city = normalizeAddress(r[1]);
    let score = -1;
    if (q.startsWith(key) && r[2] !== "") score = 1000 + key.length; // 番地まで入れた住所：町域まで一致
    else if (key === q) score = 900;
    else if (key.includes(q)) score = 500 - (key.length - q.length);
    else if (q.startsWith(city) && key.includes(q.slice(city.length)) && q.length > city.length) score = 400;
    if (score >= 0) scored.push({ e: toEntry(code, r), score });
  }
  scored.sort((a, b) => b.score - a.score || (a.e.zip < b.e.zip ? -1 : 1));
  // 番地まで入れたときは、町域まで一致したものだけにする（ほかの候補を混ぜない）
  const exact = scored.filter((s) => s.score >= 1000);
  const list = exact.length > 0 ? exact : scored;
  return { results: list.slice(0, POSTAL_RESULT_MAX).map((s) => s.e), truncated: list.length > POSTAL_RESULT_MAX, prefCode: code };
}

/** 住所を1行の文字にする（町域が空のときは市区町村まで） */
export function entryAddress(e: PostalEntry): string {
  return `${e.pref}${e.city}${e.town}`;
}
