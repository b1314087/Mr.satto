import type { Tool } from "./types";
import { getCategory } from "./categories";

/**
 * ツール検索（13章 / Phase 19 4-5章 / サイト内検索改善の工程で拡張）。
 *
 * 検索はすべてブラウザ内で行う（サーバーへの問い合わせ・外部AI・新しいライブラリは使わない）。
 * 対象はツール名・説明・ID・カテゴリ名・検索用キーワード（data.ts の keywords）。
 * キーワードは data.ts の1か所で管理し、ここには「どのツールにも共通する言い換え」だけを置く。
 *
 * 流れ：
 * 1. 文字のゆれをそろえる（全角半角・大文字小文字・ひらがなカタカナ・「エクセル→excel」など）。
 * 2. 入力を語に分ける。空白に加え、「PDFをExcelに」のような文の「を」「に」なども区切りにし、
 *    「〜したい」「〜する」などの語尾や「無料」「ツール」などの意味の薄い語を取り除く。
 * 3. 「軽くしたい→圧縮」「白黒→モノクロ・グレースケール」のような言い換え（SYNONYMS）を足す。
 * 4. すべての語が当てはまるツールだけを残し（AND検索）、関係の深い順に並べる。
 */

// ---------------------------------------------------------------------------
// 文字のゆれをそろえる
// ---------------------------------------------------------------------------

/** ひらがなをカタカナにそろえる（「えくせる」と「エクセル」を同じに扱うため） */
function foldKana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

/**
 * 呼び方の違い（表記ゆれ）。検索語とツールの情報の両方に同じ置き換えをかける。
 * カタカナにそろえた後の文字で書く（ひらがなで入力しても当てはまる）。
 */
const SPELLING_VARIANTS: readonly [RegExp, string][] = [
  [/エクセル/g, "excel"],
  // 「パスワード」「キーワード」の「ワード」は Word ではないので置き換えない
  [/(?<![スー])ワード/g, "word"],
  [/パワーポイント|パワポ/g, "powerpoint"],
  [/ピーディーエフ/g, "pdf"],
  [/ジェイペグ|ジェーペグ/g, "jpeg"],
  // 「H.264」「h264」を同じにする
  [/h\.(26[45])/g, "h$1"],
];

/** 検索語とツールの情報に共通の正規化（全角半角・大文字小文字・かな・表記ゆれ） */
export function normalizeForSearch(s: string): string {
  let out = foldKana(s.normalize("NFKC").toLowerCase());
  for (const [pattern, replacement] of SPELLING_VARIANTS) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// 言い換え（作業目的からの検索）
// ---------------------------------------------------------------------------

interface SynonymEntry {
  /** この言葉で始まる検索語に当てはめる（「軽く」なら「軽く」「軽くしたい」の両方） */
  keys: readonly string[];
  /** 足す検索語。どれか1つがツールに当てはまればよい */
  alts: readonly string[];
  /**
   * true のときは、絞り込みには使わず、当てはまるツールを少し上に出すだけにする
   * （「変えたい」「直したい」など、それだけではツールを決められない動詞）。
   */
  soft?: boolean;
}

/**
 * 言い換えの一覧。実在するツールの名前・説明・キーワードに出てくる言葉へつなぐ。
 * 特定のツールにだけ関係する呼び方は、ここではなく data.ts のそのツールの keywords に書く。
 */
const SYNONYMS: readonly SynonymEntry[] = [
  { keys: ["軽く", "軽い", "軽量", "減らす", "減らし", "減ら"], alts: ["圧縮", "軽量化", "容量"] },
  { keys: ["容量", "ファイルサイズ"], alts: ["容量", "ファイルサイズ", "圧縮", "軽量化"] },
  { keys: ["小さく"], alts: ["圧縮", "縮小", "リサイズ", "軽量化"] },
  { keys: ["大きく"], alts: ["拡大", "リサイズ"] },
  { keys: ["大きさ", "サイズを変", "サイズ変"], alts: ["リサイズ", "サイズ変更", "サイズ", "解像度"] },
  { keys: ["白黒", "モノクロ", "グレースケール", "グレー"], alts: ["白黒", "モノクロ", "グレースケール", "grayscale"] },
  { keys: ["まとめて", "一括", "いっぺんに", "一気に"], alts: ["一括", "まとめて", "複数"] },
  {
    keys: ["まとめ", "くっつけ", "つなげ", "つなぎ", "合体", "合わせ", "ひとつに", "1つに", "一つに", "マージ"],
    alts: ["結合", "まとめる", "マージ", "連結", "統合"],
  },
  { keys: ["向き"], alts: ["回転", "向き"] },
  { keys: ["回す", "回し"], alts: ["回転"] },
  { keys: ["取り出", "取出", "抜き出", "読み取", "読みと"], alts: ["抽出", "取り出", "読み取", "テキスト"] },
  { keys: ["文字"], alts: ["文字", "テキスト"] },
  { keys: ["テキスト"], alts: ["テキスト", "文字"] },
  { keys: ["形式", "ファイル形式", "拡張子"], alts: ["形式", "変換"] },
  { keys: ["切り抜", "切り取", "切抜"], alts: ["トリミング", "切り抜き", "切り取り", "クロップ", "カット"] },
  { keys: ["透明", "背景を消", "背景消"], alts: ["透過", "背景除去"] },
  // トップページの検索改善：「動画を短くする」「長さを詰める」→ トリミング（切り取り）
  { keys: ["短く", "短い", "詰め"], alts: ["トリミング", "切り取り", "カット"] },
  { keys: ["ぼかし", "ぼかす", "隠す", "隠し"], alts: ["モザイク", "ぼかし", "黒塗り", "隠す"] },
  { keys: ["写真"], alts: ["写真", "画像"] },
  { keys: ["ムービー", "ビデオ"], alts: ["動画"] },
  { keys: ["音楽", "オーディオ"], alts: ["音声"] },
  { keys: ["はんこ", "印鑑"], alts: ["印鑑", "電子印鑑", "印影"] },
  // それだけではツールが決まらない動詞（並び順にだけ使う）
  { keys: ["変え", "変える", "変更"], alts: ["変換", "変更"], soft: true },
  { keys: ["直し", "直す", "直"], alts: ["修正", "直す"], soft: true },
  { keys: ["入力", "入れ", "書き込", "打ち込"], alts: ["入力", "記入", "書き込"], soft: true },
  { keys: ["作り", "作る", "つくる", "つくり"], alts: ["作成", "生成"], soft: true },
  // 「背景を消す」「余白を消したい」など。何を消すかは、ほかの語で決まる
  { keys: ["消す", "消し", "消去", "消"], alts: ["除去", "削除", "消去", "透過"], soft: true },
];

/** 正規化済みの言い換え（最初に1回だけ作る） */
const NORMALIZED_SYNONYMS = SYNONYMS.map((entry) => ({
  keys: entry.keys.map(normalizeForSearch),
  alts: entry.alts.map(normalizeForSearch),
  soft: entry.soft ?? false,
}));

/**
 * 検索語に当てはまる言い換えを探す。複数の言葉が当てはまるときは、いちばん長い言葉を使う
 * （「まとめて変更」は「まとめ（結合）」ではなく「まとめて（一括）」として扱う）。
 */
function findSynonym(term: string) {
  let best: (typeof NORMALIZED_SYNONYMS)[number] | null = null;
  let bestLength = 0;
  for (const entry of NORMALIZED_SYNONYMS) {
    for (const key of entry.keys) {
      if (key.length > bestLength && term.startsWith(key)) {
        best = entry;
        bestLength = key.length;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// 入力を語に分ける
// ---------------------------------------------------------------------------

/** 語の終わりから取り除く言い方（長いものから順に試す） */
const SUFFIXES = [
  "したいです",
  "したい",
  "できます",
  "できる",
  "します",
  "しよう",
  "したら",
  "して",
  "する",
  "たいです",
  "たい",
  "ます",
  "ください",
  "ほしい",
  "方法",
  "やり方",
  "ツール",
  "アプリ",
];

/** 意味の薄い語（ほかに語があるときだけ取り除く） */
const STOPWORDS = new Set(
  ["無料", "オンライン", "ツール", "アプリ", "サイト", "方法", "やり方", "簡単", "かんたん", "web", "ウェブ", "したい", "する", "やりたい", "できる", "使い方"].map(
    normalizeForSearch
  )
);

function stripSuffix(token: string): string {
  for (const suffix of SUFFIXES) {
    if (token.length > suffix.length && token.endsWith(suffix)) {
      const stripped = token.slice(0, -suffix.length);
      // 「したい」から「たい」を取って「し」だけが残るような、ひらがな1文字の語は作らない
      // （「画像を白黒にしたい」で「し」が検索語になり、説明文に「し」を含むかどうかで結果が変わっていたため。工程3）
      return /^[ぁ-ゟ]$/.test(stripped) ? token : stripped;
    }
  }
  return token;
}

/**
 * 入力を語に分ける。
 * - 空白・読点などで区切る。
 * - 「を」「から」「まで」はいつでも区切る（言葉の途中に出てくることがほとんどないため）。
 * - 「に」「へ」「で」「が」「は」「の」「と」「も」は、直前が漢字・カタカナ・英数字のときだけ区切る
 *   （「PDFを Excelに」「画像の」は区切り、「はんこ」「つなげる」のような言葉の中は区切らない）。
 */
function tokenize(rawQuery: string): string[] {
  let s = rawQuery.normalize("NFKC").toLowerCase();
  s = s.replace(/[、。,!?！？「」『』()（）［］[\]【】]/g, " ");
  s = s.replace(/を|から|まで/g, " ");
  s = s.replace(/([^ぁ-ゟ\s])(に|へ|で|が|は|の|と|も)/g, "$1 ");
  // 英数字と日本語の境目でも区切る（「PDFまとめる」→「pdf まとめる」、「画像png」→「画像 png」）
  s = s.replace(/([a-z0-9])(?=[^\x00-\x7f\s])/g, "$1 ").replace(/([^\x00-\x7f\s])(?=[a-z0-9])/g, "$1 ");
  return s
    .split(/\s+/)
    .map(stripSuffix)
    .map(normalizeForSearch)
    .filter((t) => t.length > 0);
}

interface QueryTerm {
  text: string;
  alts: string[];
  soft: boolean;
}

function buildTerms(rawQuery: string): QueryTerm[] {
  const tokens = tokenize(rawQuery);
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  const words = meaningful.length > 0 ? meaningful : tokens;

  const terms = words.map((text) => {
    const synonym = findSynonym(text);
    return {
      text,
      alts: synonym ? synonym.alts.filter((a) => a !== text) : [],
      soft: synonym?.soft ?? false,
    };
  });
  // 動詞だけの検索（例:「変えたい」）は、絞り込みにも使う（そうしないと全部のツールが出てしまう）
  if (terms.length > 0 && terms.every((t) => t.soft)) {
    for (const t of terms) t.soft = false;
  }
  return terms;
}

// ---------------------------------------------------------------------------
// 当てはまり具合の計算
// ---------------------------------------------------------------------------

/**
 * 1つの文字列と1つの語の一致度。完全一致 > 前方一致 > 部分一致（従来の重み付けを維持）。
 * 英数字の語は、英単語の途中では当てはめない（「word」が「password」に当たらないように）。
 */
function matchScore(haystack: string, term: string): number {
  if (haystack === term) return 10;
  if (haystack.startsWith(term)) return 5;
  if (/^[a-z0-9]/.test(term)) {
    let index = haystack.indexOf(term);
    while (index > 0) {
      if (!/[a-z0-9]/.test(haystack[index - 1])) return 2;
      index = haystack.indexOf(term, index + 1);
    }
    return 0;
  }
  return haystack.includes(term) ? 2 : 0;
}

/**
 * 項目ごとの重み。ツール名 > 説明 > キーワード（別名）・ID > カテゴリ名。
 * 名前に当てはまるツールほど上に出る。
 */
const FIELD_WEIGHTS = { name: 3, description: 2, keywords: 1.5, id: 1.5, category: 1 } as const;

/** 言い換えで当てはまったときの重み（元の語で当てはまったときより下げる） */
const SYNONYM_FACTOR = 0.6;
/** 並び順にだけ使う語の重み */
const SOFT_FACTOR = 0.5;
/** 2語以上の検索で残す、最上位のスコアに対する割合 */
const RELEVANCE_CUTOFF = 0.35;

interface PreparedTool {
  name: string;
  nameCompact: string;
  arrow: { from: string; to: string } | null;
  fields: { text: string; weight: number }[];
}

/** 検索に使うツールの項目（トップページの検索候補では、この項目だけを画面に渡す） */
export type SearchableTool = Pick<Tool, "id" | "name" | "description" | "category" | "keywords">;

const preparedCache = new WeakMap<SearchableTool, PreparedTool>();

function prepare(tool: SearchableTool): PreparedTool {
  const cached = preparedCache.get(tool);
  if (cached) return cached;
  const name = normalizeForSearch(tool.name);
  const [from, to] = name.split("→");
  const prepared: PreparedTool = {
    name,
    nameCompact: name.replace(/\s/g, ""),
    // 「PDF→Excel」のような変換ツールは、変換の向きを並び順に使う
    arrow: to !== undefined ? { from, to } : null,
    fields: [
      { text: name, weight: FIELD_WEIGHTS.name },
      { text: normalizeForSearch(tool.description), weight: FIELD_WEIGHTS.description },
      { text: tool.id.toLowerCase(), weight: FIELD_WEIGHTS.id },
      { text: normalizeForSearch(getCategory(tool.category)?.name ?? ""), weight: FIELD_WEIGHTS.category },
      ...(tool.keywords ?? []).map((k) => ({ text: normalizeForSearch(k), weight: FIELD_WEIGHTS.keywords })),
    ],
  };
  preparedCache.set(tool, prepared);
  return prepared;
}

function scoreText(prepared: PreparedTool, text: string): number {
  let best = 0;
  for (const field of prepared.fields) {
    const s = field.weight * matchScore(field.text, text);
    if (s > best) best = s;
  }
  return best;
}

/** 1つの語のスコア（元の語と言い換えのうち、いちばん高いもの） */
function scoreTerm(prepared: PreparedTool, term: QueryTerm): number {
  let best = scoreText(prepared, term.text);
  for (const alt of term.alts) {
    const s = SYNONYM_FACTOR * scoreText(prepared, alt);
    if (s > best) best = s;
  }
  return best;
}

function termHits(part: string, term: QueryTerm): boolean {
  return [term.text, ...term.alts].some((t) => matchScore(part, t) > 0);
}

/**
 * 変換の向きが入力と合っていれば加点する。
 * 「PDFをExcelに」「pdf excel」はPDF→Excelを、「ExcelをPDFに」はExcel→PDFを上に出す。
 */
function directionBonus(prepared: PreparedTool, terms: QueryTerm[]): number {
  if (!prepared.arrow) return 0;
  const fromIndex = terms.findIndex((t) => termHits(prepared.arrow!.from, t));
  if (fromIndex < 0) return 0;
  const toIndex = terms.findIndex((t, i) => i > fromIndex && termHits(prepared.arrow!.to, t));
  return toIndex > fromIndex ? 20 : 0;
}

/** 入力全体がツール名と同じ・ツール名の先頭と同じなら大きく加点する（正式名称の検索を最上位にする） */
function wholeNameBonus(prepared: PreparedTool, compactQuery: string): number {
  if (compactQuery.length === 0) return 0;
  if (prepared.nameCompact === compactQuery) return 100;
  if (compactQuery.length >= 2 && prepared.nameCompact.startsWith(compactQuery)) return 30;
  return 0;
}

/**
 * ツールを検索し、関係の深い順に返す。
 * すべての語（並び順にだけ使う語を除く）が、元の語か言い換えのどちらかで当てはまるツールだけを残す。
 * 当てはまるツールがなければ空の配列を返す（一覧側が「該当するツールが見つかりませんでした」と出す）。
 */
export function searchTools<T extends SearchableTool>(tools: T[], rawQuery: string): T[] {
  const terms = buildTerms(rawQuery);
  if (terms.length === 0) return tools;

  const compactQuery = normalizeForSearch(rawQuery).replace(/\s/g, "");
  const hardTerms = terms.filter((t) => !t.soft);

  const scored: { tool: T; score: number; index: number }[] = [];
  tools.forEach((tool, index) => {
    const prepared = prepare(tool);
    let total = 0;
    for (const term of terms) {
      const s = scoreTerm(prepared, term);
      if (term.soft) {
        total += SOFT_FACTOR * s;
        continue;
      }
      // AND検索: 1語でも当てはまらないツールは除く
      if (s === 0) return;
      total += s;
    }
    total += directionBonus(prepared, hardTerms) + wholeNameBonus(prepared, compactQuery);
    scored.push({ tool, score: total, index });
  });

  // 同じスコアなら元の並び順（一覧の順）を保つ
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  // 2語以上の検索（例:「PDFをExcelに」）では、いちばん当てはまるツールに比べて大きく劣るもの
  // （説明文の中に、たまたま両方の言葉が出てくるだけのツール）は出さない。
  // 1語だけの検索（例:「PDF」）は、その言葉を含むツールを従来どおりすべて出す。
  if (hardTerms.length >= 2 && scored.length > 0) {
    const threshold = scored[0].score * RELEVANCE_CUTOFF;
    return scored.filter((entry) => entry.score >= threshold).map((entry) => entry.tool);
  }
  return scored.map((entry) => entry.tool);
}
