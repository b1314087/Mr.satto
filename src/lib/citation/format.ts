/**
 * 参考文献リストの整形。
 *
 * 入力(書籍・論文・Webページ)から、日本語の標準的な書き方・APA第7版・IEEEの3形式で文字列を作る。
 * APAなどで斜体にする部分(書名・誌名)は、プレーンテキストだけでは表せないため、
 * 「文字列と斜体フラグ」の並び(Segment[])で表し、画面表示(斜体)・プレーンテキスト・HTMLの
 * 3通りに変換できるようにしている(Wordなどへ貼り付けるときは書式付きでコピーできる)。
 *
 * 各形式は代表的な書き方に沿った実用的な整形であり、学会・大学・出版社ごとの細かな規定
 * (句読点・略語・ページ表記など)と完全に一致することは保証しない。提出先の規定を確認すること。
 */

export type ReferenceType = "book" | "article" | "web";
export type CitationStyle = "ja" | "apa" | "ieee";
export type SortOrder = "input" | "author" | "year";
export type NumberingStyle = "none" | "dot" | "bracket";

export interface ReferenceEntry {
  id: string;
  type: ReferenceType;
  /** 著者。「、」「,」「;」「改行」で区切る */
  authors: string;
  year: string;
  title: string;
  /** 書籍: 出版社 */
  publisher: string;
  /** 書籍: 版(例: 第2版) */
  edition: string;
  /** 論文: 雑誌名 */
  journal: string;
  volume: string;
  issue: string;
  /** 論文: ページ(例: 12-34) */
  pages: string;
  /** Web: サイト名 */
  siteName: string;
  url: string;
  /** Web: 閲覧日(YYYY-MM-DD) */
  accessed: string;
}

export interface Segment {
  text: string;
  italic?: boolean;
}

export interface FormatOptions {
  style: CitationStyle;
  sort: SortOrder;
  numbering: NumberingStyle;
  /** trueなら著者を全員書く。falseは日本語形式で4人以上のとき「ほか」で省略 */
  allAuthors: boolean;
}

export function createEmptyEntry(type: ReferenceType = "book", id = ""): ReferenceEntry {
  return {
    id,
    type,
    authors: "",
    year: "",
    title: "",
    publisher: "",
    edition: "",
    journal: "",
    volume: "",
    issue: "",
    pages: "",
    siteName: "",
    url: "",
    accessed: "",
  };
}

const CJK_RE = /[　-鿿＀-￯]/;

export function isJapaneseText(text: string): boolean {
  return CJK_RE.test(text);
}

/** 著者欄を1人ずつに分ける */
export function splitAuthors(raw: string): string[] {
  return raw
    .split(/[、,;；\n]/)
    .map((a) => a.trim())
    .filter((a) => a !== "");
}

/** 欧文の「名 姓」を「姓, N.」にする。すでに「姓, 名」の形、日本語名はそのまま */
function toApaAuthor(name: string): string {
  if (isJapaneseText(name)) return name;
  const initials = (given: string) =>
    given
      .split(/[\s-]+/)
      .filter(Boolean)
      .map((g) => `${g[0].toUpperCase()}.`)
      .join(" ");
  // 「姓, 名」はカンマ区切りで分けられてしまうため、ここに来る時点で1つの名前(姓 名)として扱う
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  const family = parts[parts.length - 1];
  return `${family}, ${initials(parts.slice(0, -1).join(" "))}`;
}

function toIeeeAuthor(name: string): string {
  if (isJapaneseText(name)) return name;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return name;
  const family = parts[parts.length - 1];
  const given = parts
    .slice(0, -1)
    .map((g) => `${g[0].toUpperCase()}.`)
    .join(" ");
  return `${given} ${family}`;
}

function joinAuthors(entry: ReferenceEntry, options: FormatOptions): string {
  const authors = splitAuthors(entry.authors);
  if (authors.length === 0) return "";
  const japanese = authors.some(isJapaneseText);

  if (options.style === "ja") {
    if (!options.allAuthors && authors.length > 3) return `${authors[0]}ほか`;
    return authors.join(", ");
  }
  if (options.style === "apa") {
    const list = authors.map(toApaAuthor);
    if (japanese) return list.join(", ");
    if (list.length === 1) return list[0];
    if (list.length === 2) return `${list[0]}, & ${list[1]}`;
    return `${list.slice(0, -1).join(", ")}, & ${list[list.length - 1]}`;
  }
  // ieee
  const list = authors.map(toIeeeAuthor);
  if (!options.allAuthors && list.length > 6) return `${list[0]} et al.`;
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function endWithPeriod(text: string): string {
  const t = text.trim();
  if (t === "") return "";
  return /[.。．!?！？]$/.test(t) ? t : `${t}.`;
}

function formatAccessed(accessed: string, style: CitationStyle): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(accessed);
  if (!m) return accessed;
  const [, y, mo, d] = m;
  if (style === "ja") return `${y}年${Number(mo)}月${Number(d)}日`;
  if (style === "apa") {
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    return `${months[Number(mo) - 1]} ${Number(d)}, ${y}`;
  }
  return `${months3[Number(mo) - 1]} ${Number(d)}, ${y}`;
}
const months3 = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "Jun.", "Jul.", "Aug.", "Sep.", "Oct.", "Nov.", "Dec."];

type Unit = Segment | Segment[] | null;

const unitText = (u: Unit): string => (u === null ? "" : Array.isArray(u) ? u.map((x) => x.text).join("") : u.text);

/** 空の要素を除き、区切り文字でつないだセグメント列にする(配列は1つのまとまりとして扱う) */
function join(parts: Unit[], sep: string): Segment[] {
  const out: Segment[] = [];
  let first = true;
  for (const p of parts) {
    if (p === null || unitText(p).trim() === "") continue;
    if (!first) out.push({ text: sep });
    first = false;
    if (Array.isArray(p)) out.push(...p);
    else out.push(p);
  }
  return out;
}

/** 末尾のセグメントに句点(.)を付ける */
function withFinalPeriod(segments: Segment[]): Segment[] {
  if (segments.length === 0) return segments;
  const last = segments[segments.length - 1];
  return [...segments.slice(0, -1), { ...last, text: endWithPeriod(last.text) }];
}

const seg = (text: string, italic = false): Segment | null => (text.trim() === "" ? null : { text: text.trim(), italic });
const plainPeriod = (text: string): Segment | null => seg(endWithPeriod(text));

/** 1件の参考文献を整形する(番号は付けない) */
export function formatReference(entry: ReferenceEntry, options: FormatOptions): Segment[] {
  const authors = joinAuthors(entry, options);
  const year = entry.year.trim();
  const pages = entry.pages.trim();
  const volIssue = entry.volume && entry.issue ? `${entry.volume}(${entry.issue})` : entry.volume || (entry.issue ? `(${entry.issue})` : "");

  if (options.style === "ja") {
    // 日本語の標準的な形(SIST 02の考え方に沿った簡易版): 著者. 題名. 出版者, 出版年.
    if (entry.type === "book") {
      const title = entry.title.trim() + (entry.edition.trim() ? ` ${entry.edition.trim()}` : "");
      return join([plainPeriod(authors), plainPeriod(title), withFinalPeriod(join([seg(entry.publisher), seg(year)], ", "))], " ");
    }
    if (entry.type === "article") {
      const tail = withFinalPeriod(join([seg(entry.journal), seg(year), seg(volIssue), seg(pages ? (/^\d/.test(pages) ? `pp.${pages}` : pages) : "")], ", "));
      return join([plainPeriod(authors), plainPeriod(entry.title), tail], " ");
    }
    const urlPart = entry.url.trim() ? `${entry.url.trim()}${entry.accessed ? ` (参照 ${formatAccessed(entry.accessed, "ja")})` : ""}` : "";
    return join([plainPeriod(authors), plainPeriod(entry.title), plainPeriod(entry.siteName), seg(year ? `${year}.` : ""), seg(urlPart)], " ");
  }

  if (options.style === "apa") {
    const yearPart = year ? `(${year}).` : "(n.d.).";
    const lead = authors ? `${endWithPeriod(authors)} ${yearPart}` : yearPart;
    if (entry.type === "book") {
      const title = entry.title.trim() + (entry.edition.trim() ? ` (${entry.edition.trim()})` : "");
      return join([seg(lead), title.trim() ? { text: endWithPeriod(title), italic: true } : null, plainPeriod(entry.publisher)], " ");
    }
    if (entry.type === "article") {
      // 雑誌名と巻は斜体、号とページは立体: Journal, 12(3), 45-67.
      const journalUnit: Segment[] = [];
      if (entry.journal.trim()) journalUnit.push({ text: entry.journal.trim(), italic: true });
      if (entry.volume.trim()) {
        journalUnit.push({ text: journalUnit.length ? ", " : "", italic: false });
        journalUnit.push({ text: entry.volume.trim(), italic: true });
      }
      const plainTail = `${entry.issue.trim() ? `(${entry.issue.trim()})` : ""}${pages ? `${journalUnit.length || entry.issue ? ", " : ""}${pages}` : ""}`;
      if (plainTail) journalUnit.push({ text: plainTail });
      return join([seg(lead), plainPeriod(entry.title), withFinalPeriod(journalUnit.filter((x) => x.text !== ""))], " ");
    }
    return join([seg(lead), entry.title.trim() ? { text: endWithPeriod(entry.title), italic: true } : null, plainPeriod(entry.siteName), seg(entry.url.trim())], " ");
  }

  // IEEE
  const front = authors ? { text: `${authors},` } : null;
  const quotedTitle = entry.title.trim() ? { text: `“${entry.title.trim()},”` } : null;
  if (entry.type === "book") {
    const body = withFinalPeriod(join([seg(entry.title, true), seg(entry.edition), seg(entry.publisher), seg(year)], ", "));
    return join([front, body], " ");
  }
  if (entry.type === "article") {
    const pageText = pages ? (/[-–]/.test(pages) ? `pp. ${pages}` : `p. ${pages}`) : "";
    const tail = withFinalPeriod(
      join([seg(entry.journal, true), seg(entry.volume ? `vol. ${entry.volume}` : ""), seg(entry.issue ? `no. ${entry.issue}` : ""), seg(pageText), seg(year)], ", ")
    );
    return join([front, quotedTitle, tail], " ");
  }
  const available = entry.url.trim() ? `[Online]. Available: ${entry.url.trim()}${entry.accessed ? ` (accessed ${formatAccessed(entry.accessed, "ieee")}).` : ""}` : "";
  return join([front, quotedTitle, plainPeriod(entry.siteName), seg(available)], " ");
}

export function segmentsToPlain(segments: Segment[]): string {
  return segments.map((s) => s.text).join("");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function segmentsToHtml(segments: Segment[]): string {
  return segments.map((s) => (s.italic ? `<i>${escapeHtml(s.text)}</i>` : escapeHtml(s.text))).join("");
}

function sortKeyAuthor(entry: ReferenceEntry): string {
  return splitAuthors(entry.authors)[0] ?? entry.title;
}

export function sortEntries(entries: ReferenceEntry[], order: SortOrder): ReferenceEntry[] {
  if (order === "input") return [...entries];
  const copy = [...entries];
  if (order === "author") {
    copy.sort((a, b) => sortKeyAuthor(a).localeCompare(sortKeyAuthor(b), "ja"));
  } else {
    copy.sort((a, b) => (Number(a.year) || 9999) - (Number(b.year) || 9999));
  }
  return copy;
}

export interface FormattedReference {
  id: string;
  /** 番号を含む表示用の全体 */
  segments: Segment[];
  /** 必須項目の不足(画面で注意として表示する) */
  warnings: string[];
}

/** 入力不足の注意 */
export function validateEntry(entry: ReferenceEntry): string[] {
  const w: string[] = [];
  if (entry.title.trim() === "") w.push("題名が未入力です");
  if (entry.type !== "web" && entry.authors.trim() === "") w.push("著者が未入力です");
  if (entry.year.trim() === "" && entry.type !== "web") w.push("発行年が未入力です");
  if (entry.type === "book" && entry.publisher.trim() === "") w.push("出版社が未入力です");
  if (entry.type === "article" && entry.journal.trim() === "") w.push("雑誌名が未入力です");
  if (entry.type === "web" && entry.url.trim() === "") w.push("URLが未入力です");
  return w;
}

/** 空の項目だけ(全項目が空)のエントリは出力しない */
export function isBlankEntry(entry: ReferenceEntry): boolean {
  return (
    entry.authors.trim() === "" &&
    entry.title.trim() === "" &&
    entry.publisher.trim() === "" &&
    entry.journal.trim() === "" &&
    entry.siteName.trim() === "" &&
    entry.url.trim() === ""
  );
}

export function formatReferenceList(entries: ReferenceEntry[], options: FormatOptions): FormattedReference[] {
  const sorted = sortEntries(entries.filter((e) => !isBlankEntry(e)), options.sort);
  return sorted.map((entry, i) => {
    const body = formatReference(entry, options);
    const num = options.style === "ieee" && options.numbering === "none" ? "bracket" : options.numbering;
    const prefix = num === "dot" ? `${i + 1}. ` : num === "bracket" ? `[${i + 1}] ` : "";
    return { id: entry.id, segments: prefix ? [{ text: prefix }, ...body] : body, warnings: validateEntry(entry) };
  });
}
