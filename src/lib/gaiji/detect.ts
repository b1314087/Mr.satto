/**
 * 外字・特殊文字チェックの判定ロジック（純粋な関数だけ。ブラウザの外でもテストできる）。
 *
 * 【何を判定するか】文字コード（Unicodeの番号）の範囲だけで判定する。次のような、受け取る側の環境しだいで
 * 文字化け・表示できない・照合できないといった問題が起きやすい文字を見つける。
 * - 私用領域の文字（外字の可能性が高い）、文字化けの跡（U+FFFD・〓）、制御文字
 * - 異体字セレクタ、互換漢字、結合文字（濁点が別の文字になったもの）、補助面の文字・絵文字
 * - 不可視の文字（ゼロ幅スペースなど）、特殊な空白（改行しない空白など）
 * - 「Shift_JIS（Windows系）で保存・取り込みする場合」に問題になる文字（機種依存文字・保存できない文字・別の文字に変わる文字・半角カナ）
 *
 * 【判定できないこと（画面にも明記する）】
 * - 受け取る側のフォントで実際に表示できるかどうか。文字コードが標準でも、フォントに字形が無ければ表示されない。
 * - 私用領域の文字が「何の字か」。外字の中身は、登録したパソコンの中にしか無い。
 * - 見た目が同じで、文字コードだけが違う文字の「正しさ」。
 * - 検出がすべてを網羅するという保証。検出漏れ・誤検出がありうる。
 */

export type GaijiCategory =
  | "control"
  | "replacement"
  | "private-use"
  | "variation-selector"
  | "invisible"
  | "unusual-space"
  | "combining"
  | "compat-ideograph"
  | "radical"
  | "emoji"
  | "supplementary"
  | "ext-dep"
  | "sjis-mismatch"
  | "not-sjis"
  | "halfwidth-kana";

export type GaijiSeverity = "high" | "mid" | "low";

export interface CategoryInfo {
  id: GaijiCategory;
  label: string;
  severity: GaijiSeverity;
  /** その文字が何か（短く） */
  summary: string;
  /** 見つかったときの対処 */
  advice: string;
  /** Shift_JISの確認を有効にしたときだけ出る分類か */
  shiftJisOnly: boolean;
}

export const CATEGORY_INFO: Record<GaijiCategory, CategoryInfo> = {
  control: {
    id: "control",
    label: "制御文字",
    severity: "high",
    summary: "画面には出ない、機器への命令用の文字（タブ・改行を除く）",
    advice: "ほとんどの場合、混ざり込んだ不要な文字です。削除してください。",
    shiftJisOnly: false,
  },
  replacement: {
    id: "replacement",
    label: "文字化けの跡",
    severity: "high",
    summary: "読み取れなかった文字の代わりに入る記号（�・〓）",
    advice: "元の文字が失われています。元のデータ（元のファイル・書類）を確かめて、正しい文字を入れ直してください。",
    shiftJisOnly: false,
  },
  "private-use": {
    id: "private-use",
    label: "外字（私用領域）",
    severity: "high",
    summary: "そのパソコン・システムの中だけで字形が決まる文字（人名の異体字などの外字）",
    advice: "別のパソコンやPDF・メール・Webでは表示されない、または別の文字になります。受け取る相手に正しく伝わる文字（通常の漢字・異体字セレクタつきの文字）に直すか、画像・PDFにして渡してください。",
    shiftJisOnly: false,
  },
  "variation-selector": {
    id: "variation-selector",
    label: "異体字セレクタ",
    severity: "mid",
    summary: "直前の漢字の字形（異体字）を指定する、見えない文字",
    advice: "対応していないフォント・システムでは、字形が変わったり、見えない文字として残ったりします。字形が大切でなければ、直前の通常の漢字にそろえてください。",
    shiftJisOnly: false,
  },
  invisible: {
    id: "invisible",
    label: "不可視の文字",
    severity: "mid",
    summary: "見えない文字（ゼロ幅スペース・BOM・ソフトハイフンなど）",
    advice: "見た目では分からないまま、検索・照合・数式・名前の一致に失敗する原因になります。不要なら削除してください（下の「整えたテキスト」で取り除けます）。",
    shiftJisOnly: false,
  },
  "unusual-space": {
    id: "unusual-space",
    label: "特殊な空白",
    severity: "mid",
    summary: "通常のスペースに似た、別の空白（改行しない空白など）",
    advice: "通常のスペースとして扱われず、検索・照合・区切りに失敗することがあります。通常のスペースに置き換えてください（下の「整えたテキスト」で置き換えられます）。",
    shiftJisOnly: false,
  },
  combining: {
    id: "combining",
    label: "結合文字（濁点の分離など）",
    severity: "mid",
    summary: "直前の文字に重ねて表示する記号。「か」＋「゛」のように、濁点が別の文字になった形（Macのファイル名などで起きる）",
    advice: "見た目は同じでも、検索・照合で別の文字として扱われます。「が」のように合成した形にそろえてください（下の「整えたテキスト」で合成できます）。",
    shiftJisOnly: false,
  },
  "compat-ideograph": {
    id: "compat-ideograph",
    label: "互換漢字",
    severity: "mid",
    summary: "旧字・人名の異体字などのために、別のコードが割り当てられた漢字（﨑・神・福など）",
    advice: "見た目が同じ通常の漢字と、別の文字として扱われ、検索・照合で一致しないことがあります。人名などで字形が大切な場合は、そのまま使うか、相手のシステムで使える文字か確かめてください。",
    shiftJisOnly: false,
  },
  radical: {
    id: "radical",
    label: "部首の文字（漢字にそっくりな別の文字）",
    severity: "mid",
    summary: "康熙部首・CJK部首補助と呼ばれる、「日」「月」「金」などの漢字にそっくりな別の文字（PDFからコピーしたときに混ざりやすい）",
    advice: "見た目は普通の漢字と同じでも、検索・並べ替え・照合で一致しません。普通の漢字に置き換えてください（康熙部首は、下の「整えたテキスト」で置き換えられます）。",
    shiftJisOnly: false,
  },
  emoji: {
    id: "emoji",
    label: "絵文字・絵記号",
    severity: "mid",
    summary: "絵文字や、絵として表示される記号",
    advice: "古いシステム・業務ソフト・Shift_JISのファイルでは、表示できない・文字化けすることがあります。必要なければ、通常の文字に置き換えてください。",
    shiftJisOnly: false,
  },
  supplementary: {
    id: "supplementary",
    label: "補助面の文字（𠮷など）",
    severity: "mid",
    summary: "基本の範囲を超えた番号をもつ文字（𠮷・𩸽など、2文字分として数えられる文字）",
    advice: "古いシステムでは表示できない、文字数が合わない、保存で文字化けする原因になります。相手のシステムで使えるか確かめてください。",
    shiftJisOnly: false,
  },
  "ext-dep": {
    id: "ext-dep",
    label: "機種依存文字",
    severity: "mid",
    summary: "Windows系のShift_JISで、標準の範囲の外にある文字（①・Ⅰ・㈱・㌔・髙・﨑・ローマ数字など）",
    advice: "Shift_JISで保存・取り込みする古い業務ソフト・Macなどの別の環境で、文字化けすることがあります。「(株)」「1」のような通常の文字に置き換えられる場合は、「整えたテキスト」で置き換えられます。",
    shiftJisOnly: true,
  },
  "sjis-mismatch": {
    id: "sjis-mismatch",
    label: "Shift_JIS変換で別の文字に変わる文字",
    severity: "mid",
    summary: "〜（波ダッシュ）・‖・−・¢・£・¬・— など。Shift_JIS（Windows系）に変換すると、見た目の近い別の文字（～・∥・－・￠・￡・￢・―）に変わる、または「?」になる文字",
    advice: "Shift_JISで保存・取り込みすると、文字が変わる・「?」になることがあります。見た目の近い、Shift_JISで安全な文字（～ ∥ － ￠ ￡ ￢ ―）に置き換えるか、UTF-8で保存してください。",
    shiftJisOnly: true,
  },
  "not-sjis": {
    id: "not-sjis",
    label: "Shift_JISに無い文字",
    severity: "low",
    summary: "Shift_JIS（Windows系）で保存できない文字（é・ハングル・一部の記号や旧字など）",
    advice: "Shift_JISで保存すると「?」に変わる、または保存に失敗します。UTF-8で保存するか、別の文字に置き換えてください。UTF-8で扱う環境では、問題にならないことがほとんどです。",
    shiftJisOnly: true,
  },
  "halfwidth-kana": {
    id: "halfwidth-kana",
    label: "半角カナ",
    severity: "low",
    summary: "半角のカタカナ（ｱｲｳ・ﾊﾞ など）",
    advice: "Shift_JISでは保存できますが、受け付けない入力欄・システム（銀行の名義欄など以外）があります。全角のカタカナにそろえたいときは、「整えたテキスト」で置き換えられます。",
    shiftJisOnly: true,
  },
};

export const CATEGORY_ORDER: GaijiCategory[] = [
  "control",
  "replacement",
  "private-use",
  "variation-selector",
  "invisible",
  "unusual-space",
  "combining",
  "compat-ideograph",
  "radical",
  "supplementary",
  "emoji",
  "ext-dep",
  "sjis-mismatch",
  "not-sjis",
  "halfwidth-kana",
];

export const SEVERITY_LABEL: Record<GaijiSeverity, string> = {
  high: "要確認",
  mid: "注意",
  low: "参考",
};

// ---------------------------------------------------------------------------
// 文字の範囲
// ---------------------------------------------------------------------------

export function isPrivateUse(cp: number): boolean {
  return (cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd) || (cp >= 0x100000 && cp <= 0x10fffd);
}

export function isVariationSelector(cp: number): boolean {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

/** 制御文字（タブ・改行・復帰は、ふつうの文字として扱い、含めない） */
export function isControl(cp: number): boolean {
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  return cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);
}

const INVISIBLE_POINTS = new Set<number>([
  0x00ad, // ソフトハイフン
  0x034f, // 結合書記素ジョイナー
  0x061c,
  0x180e,
  0xfeff, // BOM（ゼロ幅の改行しない空白）
]);

export function isInvisible(cp: number): boolean {
  if (INVISIBLE_POINTS.has(cp)) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true; // ゼロ幅・方向記号
  if (cp >= 0x202a && cp <= 0x202e) return true; // 方向の制御
  if (cp >= 0x2060 && cp <= 0x206f) return true; // 単語結合・不可視の演算子
  if (cp === 0x2028 || cp === 0x2029) return true; // 行区切り・段落区切り
  return false;
}

export function isUnusualSpace(cp: number): boolean {
  return cp === 0x00a0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x202f || cp === 0x205f;
}

export function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    cp === 0x3099 ||
    cp === 0x309a ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

export function isCompatIdeograph(cp: number): boolean {
  return (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
}

/** 康熙部首(U+2F00〜2FDF)・CJK部首補助(U+2E80〜2EFF) */
export function isRadical(cp: number): boolean {
  return (cp >= 0x2e80 && cp <= 0x2eff) || (cp >= 0x2f00 && cp <= 0x2fdf);
}

export function isHalfwidthKana(cp: number): boolean {
  return cp >= 0xff61 && cp <= 0xff9f;
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

export function isPictographic(cp: number): boolean {
  return PICTOGRAPHIC.test(String.fromCodePoint(cp));
}

/**
 * JIS X 0208とWindows系Shift_JIS(CP932)で、変換のときに別の文字に変わりやすい文字（有名な変換のずれ）。
 * 値は、Shift_JISで安全な、見た目の近い文字。
 */
export const SJIS_MISMATCH_REPLACEMENT: ReadonlyMap<number, string> = new Map([
  [0x301c, "～"], // 〜 波ダッシュ → 全角チルダ
  [0x2016, "∥"], // ‖ 双柱 → 平行記号
  [0x2212, "－"], // − マイナス → 全角ハイフンマイナス
  [0x00a2, "￠"],
  [0x00a3, "￡"],
  [0x00ac, "￢"],
  [0x2014, "―"], // — エムダッシュ → 水平線
]);

// ---------------------------------------------------------------------------
// Shift_JIS（Windows系）で保存できるかの判定表
// ---------------------------------------------------------------------------

/** basic: Shift_JISの標準の範囲（JIS X 0208の領域） / extension: 拡張の領域（NEC・IBMの機種依存文字） / none: 保存できない */
export type SjisClass = "basic" | "extension" | "none";

let sjisTable: Map<number, SjisClass> | null | undefined;

/**
 * ブラウザ（Node）の TextDecoder("shift_jis") で、すべての2バイトの組み合わせを読み、保存できる文字の一覧を作る
 * （自前の文字コード表を持たず、実際の変換表に従う）。作れない環境では null。
 */
export function getSjisTable(): Map<number, SjisClass> | null {
  if (sjisTable !== undefined) return sjisTable;
  try {
    const decoder = new TextDecoder("shift_jis");
    const table = new Map<number, SjisClass>();
    for (let b = 0x20; b <= 0x7e; b++) table.set(b, "basic");
    for (let b = 0xa1; b <= 0xdf; b++) {
      const s = decoder.decode(new Uint8Array([b]));
      if (s.length === 1 && s !== "�") table.set(s.charCodeAt(0), "basic");
    }
    const pair = new Uint8Array(2);
    for (let lead = 0x81; lead <= 0xfc; lead++) {
      if (lead >= 0xa0 && lead <= 0xdf) continue;
      const basicLead = (lead >= 0x81 && lead <= 0x84) || (lead >= 0x88 && lead <= 0x9f) || (lead >= 0xe0 && lead <= 0xea);
      for (let trail = 0x40; trail <= 0xfc; trail++) {
        if (trail === 0x7f) continue;
        pair[0] = lead;
        pair[1] = trail;
        const s = decoder.decode(pair);
        if (s.length !== 1 || s === "�") continue;
        const cp = s.charCodeAt(0);
        if (!basicLead && table.has(cp)) continue; // 標準の範囲にもある文字は、標準として扱う
        table.set(cp, basicLead ? "basic" : "extension");
      }
    }
    sjisTable = table;
  } catch {
    sjisTable = null;
  }
  return sjisTable;
}

export function sjisClassOf(cp: number): SjisClass | null {
  const table = getSjisTable();
  if (!table) return null;
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return "basic";
  return table.get(cp) ?? "none";
}

// ---------------------------------------------------------------------------
// 1文字の分類
// ---------------------------------------------------------------------------

export interface DetectOptions {
  /** Shift_JIS（Windows系）で保存・取り込みする場合の問題も調べる */
  checkShiftJis: boolean;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = { checkShiftJis: true };

/** 1つの文字（コードポイント）の分類。問題がなければ null */
export function classifyCodePoint(cp: number, options: DetectOptions = DEFAULT_DETECT_OPTIONS): GaijiCategory | null {
  if (cp === 0xfffd || cp === 0x3013) return "replacement";
  if (isControl(cp)) return "control";
  if (isPrivateUse(cp)) return "private-use";
  if (isVariationSelector(cp)) return "variation-selector";
  if (isInvisible(cp)) return "invisible";
  if (isUnusualSpace(cp)) return "unusual-space";
  if (isCombining(cp)) return "combining";
  if (isCompatIdeograph(cp)) return "compat-ideograph";
  if (isRadical(cp)) return "radical";
  if (cp > 0xffff) return isPictographic(cp) ? "emoji" : "supplementary";
  if (isHalfwidthKana(cp)) return options.checkShiftJis ? "halfwidth-kana" : null;
  const sjis = options.checkShiftJis ? sjisClassOf(cp) : null;
  if (sjis === "basic") return null;
  if (sjis === "extension") return "ext-dep";
  if (isPictographic(cp) && cp > 0xff) return "emoji";
  if (sjis === "none") {
    if (SJIS_MISMATCH_REPLACEMENT.has(cp)) return "sjis-mismatch";
    return "not-sjis";
  }
  return null;
}

const CHAR_NAMES: ReadonlyMap<number, string> = new Map([
  [0x00a0, "改行しない空白(NBSP)"],
  [0x00ad, "ソフトハイフン"],
  [0x1680, "オガム文字の空白"],
  [0x2000, "半角の空白(EN QUAD)"],
  [0x2001, "全角の空白(EM QUAD)"],
  [0x2002, "半角の空白(EN SPACE)"],
  [0x2003, "全角の空白(EM SPACE)"],
  [0x2004, "3分の1空白"],
  [0x2005, "4分の1空白"],
  [0x2006, "6分の1空白"],
  [0x2007, "数字幅の空白"],
  [0x2008, "句読点幅の空白"],
  [0x2009, "細い空白"],
  [0x200a, "極細の空白"],
  [0x200b, "ゼロ幅スペース"],
  [0x200c, "ゼロ幅非接合子"],
  [0x200d, "ゼロ幅接合子"],
  [0x200e, "左から右への印"],
  [0x200f, "右から左への印"],
  [0x2028, "行区切り"],
  [0x2029, "段落区切り"],
  [0x202f, "狭い改行しない空白"],
  [0x205f, "中くらいの数式用空白"],
  [0x2060, "単語結合子"],
  [0x3099, "結合用の濁点"],
  [0x309a, "結合用の半濁点"],
  [0xfeff, "BOM(ゼロ幅の改行しない空白)"],
  [0xfffd, "置換文字(文字化けの跡)"],
  [0x3013, "げた記号〓(字形を出せない文字の代用)"],
]);

/** 画面に出す、文字の名前（見えない文字・空白など、文字そのものを見せても分からないもの） */
export function nameOfCodePoint(cp: number): string | null {
  const known = CHAR_NAMES.get(cp);
  if (known) return known;
  if (isControl(cp)) return "制御文字";
  if (isVariationSelector(cp)) return cp <= 0xfe0f ? `異体字セレクタ${cp - 0xfdff}` : `異体字セレクタ${cp - 0xe0100 + 17}`;
  if (isInvisible(cp)) return "不可視の文字";
  if (isPrivateUse(cp)) return "私用領域の文字";
  if (isCombining(cp)) return "結合文字";
  return null;
}

/** 見えない文字・結合文字・外字（字形が出るとは限らない）は、文字そのものでなく、名前で見せる */
export function shouldShowAsName(cp: number): boolean {
  return isControl(cp) || isInvisible(cp) || isUnusualSpace(cp) || isVariationSelector(cp) || isCombining(cp);
}

export function formatCodePoint(cp: number): string {
  return `U+${cp.toString(16).toUpperCase().padStart(cp > 0xffff ? 5 : 4, "0")}`;
}

// ---------------------------------------------------------------------------
// 走査
// ---------------------------------------------------------------------------

/** 場所の表示用に、調べる文字列を「ひとまとまり」ごとに分ける（行・セル・段落・ページなど） */
export interface ScanUnit {
  /** 場所の名前（「3行目」「Sheet1!B2」「5ページ」など） */
  label: string;
  text: string;
}

export interface GaijiFinding {
  codePoint: number;
  char: string;
  hex: string;
  category: GaijiCategory;
  severity: GaijiSeverity;
  /** 見つかった数（同じ文字の合計） */
  count: number;
  /** 場所の例（多くなりすぎないよう、先頭からSAMPLE_LOCATIONS件） */
  locations: string[];
  /** 場所の例を省いた（見つかった場所の数が、表示した数より多い） */
  moreLocations: boolean;
  name: string | null;
  /** Shift_JISの保存で別の文字になるときの、置き換え案 */
  replacement: string | null;
}

export interface GaijiScanResult {
  findings: GaijiFinding[];
  /** 調べた文字数（コードポイントの数） */
  totalChars: number;
  /** 調べたひとまとまりの数 */
  totalUnits: number;
  /** カテゴリごとの、見つかった文字の個数（のべ） */
  byCategory: Partial<Record<GaijiCategory, number>>;
  /** Shift_JISの変換表を作れず、Shift_JISの判定ができなかった */
  sjisUnavailable: boolean;
}

export const SAMPLE_LOCATIONS = 6;
export const SCAN_MAX_CHARS = 2_000_000;

export function scanUnits(units: ScanUnit[], options: DetectOptions = DEFAULT_DETECT_OPTIONS): GaijiScanResult {
  const found = new Map<number, GaijiFinding>();
  const byCategory: Partial<Record<GaijiCategory, number>> = {};
  const classCache = new Map<number, GaijiCategory | null>();
  let totalChars = 0;

  for (const unit of units) {
    let column = 0;
    for (const ch of unit.text) {
      column++;
      totalChars++;
      const cp = ch.codePointAt(0)!;
      if (cp < 0x20 && cp !== 0x0a && cp !== 0x0d && cp !== 0x09) {
        // 下で分類する（制御文字）
      } else if (cp < 0x7f) {
        continue; // ふつうの半角英数字・記号（高速化のため）
      }
      let category = classCache.get(cp);
      if (category === undefined) {
        category = classifyCodePoint(cp, options);
        classCache.set(cp, category);
      }
      if (category === null) continue;
      byCategory[category] = (byCategory[category] ?? 0) + 1;
      let finding = found.get(cp);
      if (!finding) {
        finding = {
          codePoint: cp,
          char: ch,
          hex: formatCodePoint(cp),
          category,
          severity: CATEGORY_INFO[category].severity,
          count: 0,
          locations: [],
          moreLocations: false,
          name: nameOfCodePoint(cp),
          replacement: SJIS_MISMATCH_REPLACEMENT.get(cp) ?? null,
        };
        found.set(cp, finding);
      }
      finding.count++;
      if (finding.locations.length < SAMPLE_LOCATIONS) finding.locations.push(`${unit.label}（${column}文字目）`);
      else finding.moreLocations = true;
    }
  }

  const sevRank: Record<GaijiSeverity, number> = { high: 0, mid: 1, low: 2 };
  const findings = [...found.values()].sort(
    (a, b) =>
      sevRank[a.severity] - sevRank[b.severity] ||
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
      b.count - a.count ||
      a.codePoint - b.codePoint
  );
  return {
    findings,
    totalChars,
    totalUnits: units.length,
    byCategory,
    sjisUnavailable: options.checkShiftJis && getSjisTable() === null,
  };
}

/** 貼り付けたテキストを、行ごとのひとまとまりに分ける（場所は「○行目」） */
export function unitsFromText(text: string): ScanUnit[] {
  return text.split(/\r\n|\r|\n/).map((line, i) => ({ label: `${i + 1}行目`, text: line }));
}

// ---------------------------------------------------------------------------
// 整えたテキスト（貼り付けたテキストだけ）
// ---------------------------------------------------------------------------

export interface CleanOptions {
  /** 不可視の文字（ゼロ幅スペース・BOMなど）を取り除く */
  removeInvisible: boolean;
  /** 特殊な空白を、通常の半角スペースにする */
  normalizeSpaces: boolean;
  /** 濁点・半濁点の結合文字を合成する（「か」＋「゛」→「が」） */
  composeCombining: boolean;
  /** 機種依存文字・半角カナを、置き換えられる通常の文字にする（①→1、㈱→(株)、ｱ→ア） */
  replaceCompat: boolean;
  /** Shift_JISで別の文字に変わる文字（〜 など）を、安全な文字にする */
  replaceMismatch: boolean;
}

export interface CleanResult {
  text: string;
  invisibleRemoved: number;
  spacesReplaced: number;
  combiningComposed: number;
  compatReplaced: number;
  mismatchReplaced: number;
  /** 置き換えられなかった、問題のある文字の種類（外字・補助面・絵文字・互換漢字など） */
  remainingProblemChars: number;
}

export const DEFAULT_CLEAN_OPTIONS: CleanOptions = {
  removeInvisible: true,
  normalizeSpaces: true,
  composeCombining: true,
  replaceCompat: true,
  replaceMismatch: false,
};

function isSjisSafeText(text: string): boolean {
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x7f) continue;
    if (sjisClassOf(cp) !== "basic") return false;
  }
  return true;
}

export function cleanText(text: string, options: CleanOptions, detect: DetectOptions = DEFAULT_DETECT_OPTIONS): CleanResult {
  const result: CleanResult = {
    text,
    invisibleRemoved: 0,
    spacesReplaced: 0,
    combiningComposed: 0,
    compatReplaced: 0,
    mismatchReplaced: 0,
    remainingProblemChars: 0,
  };
  let out = text;

  if (options.removeInvisible) {
    const chars = Array.from(out);
    const kept: string[] = [];
    chars.forEach((ch, i) => {
      const cp = ch.codePointAt(0)!;
      if (!isInvisible(cp) || cp === 0x2028 || cp === 0x2029) {
        kept.push(ch);
        return;
      }
      // 絵文字をつなぐゼロ幅接合子は、取り除くと絵文字が壊れるため残す
      if (cp === 0x200d) {
        const prev = chars[i - 1]?.codePointAt(0);
        const next = chars[i + 1]?.codePointAt(0);
        if ((prev !== undefined && (isPictographic(prev) || prev === 0xfe0f)) || (next !== undefined && isPictographic(next))) {
          kept.push(ch);
          return;
        }
      }
      result.invisibleRemoved++;
    });
    out = kept.join("");
  }

  if (options.normalizeSpaces) {
    out = Array.from(out)
      .map((ch) => {
        if (isUnusualSpace(ch.codePointAt(0)!)) {
          result.spacesReplaced++;
          return " ";
        }
        return ch;
      })
      .join("");
  }

  if (options.composeCombining) {
    out = out.replace(/(\P{M})([゙゚]+)/gu, (m) => {
      const composed = m.normalize("NFC");
      if (composed !== m) result.combiningComposed++;
      return composed;
    });
  }

  if (options.replaceCompat) {
    // 康熙部首は、見た目が同じ漢字（NFKCの対応）に置き換える。CJK部首補助は対応表が無いため置き換えない
    out = out.replace(/[\u2f00-\u2fdf]/g, (ch) => {
      const converted = ch.normalize("NFKC");
      if (converted !== ch) {
        result.compatReplaced++;
        return converted;
      }
      return ch;
    });
  }

  if (options.replaceCompat && detect.checkShiftJis && getSjisTable()) {
    // 半角カナは、濁点・半濁点とつなげて全角にする（ﾊﾞ → バ）
    out = out.replace(/[｡-ﾟ]+/g, (m) => {
      const converted = m.normalize("NFKC");
      if (converted !== m && isSjisSafeText(converted)) {
        result.compatReplaced += Array.from(m).length;
        return converted;
      }
      return m;
    });
    out = Array.from(out)
      .map((ch) => {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x80 || sjisClassOf(cp) !== "extension") return ch;
        const converted = ch.normalize("NFKC");
        if (converted !== ch && isSjisSafeText(converted)) {
          result.compatReplaced++;
          return converted;
        }
        return ch;
      })
      .join("");
  }

  if (options.replaceMismatch) {
    out = Array.from(out)
      .map((ch) => {
        const replacement = SJIS_MISMATCH_REPLACEMENT.get(ch.codePointAt(0)!);
        if (replacement) {
          result.mismatchReplaced++;
          return replacement;
        }
        return ch;
      })
      .join("");
  }

  result.text = out;
  const remaining = new Set<number>();
  for (const ch of out) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x7f) continue;
    if (classifyCodePoint(cp, detect) !== null) remaining.add(cp);
  }
  result.remainingProblemChars = remaining.size;
  return result;
}
