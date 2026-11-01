import { formatCodePoint, sjisClassOf, type SjisClass } from "./detect";
import { VARIANT_GROUPS_DATA } from "./variant-data";

/**
 * 異体字（形の違う同じ字）の一覧。
 *
 * 「高橋」と入力しても、名簿や戸籍では「髙橋」（はしご高）で登録されていることがある。
 * 入力した文字に、名前でよく使われる形違いの字があれば、それも一覧に出す
 * （検索・照合で一致しない原因の確認や、正しい字のコピーに使う）。
 *
 * - 新字体・旧字体の対応と、異体字の対応の公開データ（variant-data.ts、約2,400字）に、
 *   下の名前でよく使われる形違いの字を足したもの（すべての異体字を網羅するものではない）
 * - 会社や自治体が独自に作った外字（私用領域の文字）は、作った所ごとに違うため、一覧にはない
 * - 戸籍・住民基本台帳・入管などで使われる字（MJ文字）は、MJ縮退マップ（mj-variant-data.ts）から、使うときに読み込む。
 *   異体字セレクタ（IVS）付きの字形も、ここから出る
 * - 1行（データの方は空白で区切った1語）が1つのまとまり。つながるまとまりは1つにまとめる
 */
const EXTRA_VARIANT_GROUPS = `
高髙
橋槗
崎﨑嵜碕
吉𠮷
辺邊邉
斉斎齋齊
沢澤
浜濱濵
島嶋嶌
桜櫻
広廣
国國
富冨
徳德
柳栁
恵惠
栄榮
真眞
竜龍
滝瀧
桑桒
槙槇
曽曾
関關
黒黑
条條
野埜
峰峯
館舘
晋晉
実實
寿壽
円圓
恒恆
弥彌
来來
総總
県縣
戸戶
淵渕渊
桧檜
蔵藏
瀬瀨
鶴靍靏
蛍螢
芦蘆
礼禮
亜亞
悦悅
衛衞
学學
巌巖
清淸
将將
団團
伝傳
稲稻
博愽
彦彥
緑綠
万萬
岡崗
増增
穂穗
奥奧
宝寶
仏佛
帯帶
芸藝
楽樂
梅楳
鴎鷗
祷禱
掴摑
叱𠮟
剥剝
填塡
頬頰
発發
権權
児兒
`;

/** 文字 → 同じまとまりの文字（自分を含む、文字コードの順） */
const VARIANT_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const groups = [...VARIANT_GROUPS_DATA.split(/\s+/), ...EXTRA_VARIANT_GROUPS.split(/\s+/)];
  for (const g of groups) {
    const chars = Array.from(g);
    if (chars.length < 2) continue;
    for (const c of chars) if (!parent.has(c)) parent.set(c, c);
    for (const c of chars.slice(1)) {
      const a = find(chars[0]);
      const b = find(c);
      if (a !== b) parent.set(b, a);
    }
  }
  const members = new Map<string, string[]>();
  for (const c of parent.keys()) {
    const r = find(c);
    const list = members.get(r) ?? [];
    list.push(c);
    members.set(r, list);
  }
  const index = new Map<string, string[]>();
  for (const list of members.values()) {
    list.sort((x, y) => x.codePointAt(0)! - y.codePointAt(0)!);
    for (const c of list) index.set(c, list);
  }
  return index;
})();

export interface VariantChar {
  /** 形違いの字（異体字セレクタ付きのときは、元の字＋セレクタの2文字） */
  char: string;
  /** コード（例：U+9AD9、異体字セレクタ付きは U+8FBA U+E0102） */
  hex: string;
  /** Shift_JIS での扱い（判定できない環境では null。異体字セレクタ付きは、元の字の扱い） */
  sjis: SjisClass | null;
  /** 異体字セレクタ付きの字（同じ文字コードのまま、形だけを変えたもの） */
  ivs: boolean;
  /** 異体字セレクタ付きの字の MJ文字図形名（例：MJ025759）。それ以外は null */
  mj: string | null;
  /**
   * 表示に必要な書体の目安
   * - standard：ふつうの書体（Mac・Windowsに入っている書体）で出る（Shift_JISにある字）
   * - maybe：書体によっては□などになる（Shift_JISにない字・補助面の字）。IPAmj明朝なら出る
   * - ipamj：IPAmj明朝などの対応した書体が必要（異体字セレクタ付き。ほかの書体では元の字の形になる）
   */
  font: "standard" | "maybe" | "ipamj";
}

export interface VariantFinding {
  /** 入力に含まれていた文字 */
  char: string;
  hex: string;
  /** 形違いの字（入力した文字そのものは含めない） */
  variants: VariantChar[];
  /** 見つかった数 */
  count: number;
  /** 場所の例（先頭から最大6件） */
  locations: string[];
}

export const VARIANT_SAMPLE_LOCATIONS = 6;

/** 組み込みの一覧（新字体・旧字体・異体字の公開データ）だけから引いた形違いの字 */
export function variantsOf(char: string): string[] {
  return (VARIANT_INDEX.get(char) ?? []).filter((c) => c !== char);
}

/* ---- 戸籍・住民基本台帳などの字（MJ縮退マップ）。大きいため、使うときに読み込む ---- */

export interface MjVariantIndex {
  /** 元の字 → 形違いの字（「字」または「字#MJ番号の数字」） */
  lines: ReadonlyMap<string, readonly string[]>;
  /** 形違いの字（異体字セレクタなし） → それを形違いに持つ元の字 */
  reverse: ReadonlyMap<string, readonly string[]>;
}

export function buildMjVariantIndex(data: string): MjVariantIndex {
  const lines = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();
  for (const line of data.split("\n")) {
    const tokens = line.trim().split(" ");
    if (tokens.length < 2 || tokens[0] === "") continue;
    const [base, ...rest] = tokens;
    lines.set(base, rest);
    for (const t of rest) {
      if (t.includes("#")) continue;
      const list = reverse.get(t) ?? [];
      list.push(base);
      reverse.set(t, list);
    }
  }
  return { lines, reverse };
}

let mjIndexPromise: Promise<MjVariantIndex> | null = null;

/** MJ縮退マップの一覧を読み込む（2回目からは読み込み済みのものを返す） */
export function loadMjVariantIndex(): Promise<MjVariantIndex> {
  if (!mjIndexPromise) {
    mjIndexPromise = import("./mj-variant-data").then((m) => buildMjVariantIndex(m.MJ_VARIANT_DATA)).catch((e) => {
      mjIndexPromise = null;
      throw e;
    });
  }
  return mjIndexPromise;
}

function isSingleChar(s: string): boolean {
  return Array.from(s).length === 1;
}

/**
 * 1つの字の形違いの字をすべて集める（字と、MJ番号の数字）。
 * 組み込みの一覧に加えて、MJ縮退マップでは「その字を縮退先とする字」と「その字を形違いに持つ字」と、
 * それらの字の形違いの字（2段目まで）を集める（例：辺 → 邉 → 邉の異体字セレクタ付きの字）。
 */
export function collectVariants(char: string, mj: MjVariantIndex | null): { char: string; mj: string | null }[] {
  const out = new Map<string, string | null>();
  const add = (token: string) => {
    const [g, num] = token.split("#");
    if (g === char || out.has(g)) return;
    out.set(g, num ? `MJ${num}` : null);
  };
  const plain = new Set<string>(variantsOf(char));
  if (mj) {
    for (const b of mj.reverse.get(char) ?? []) plain.add(b);
    const firstHop = [char, ...plain];
    for (const b of firstHop) {
      if (b !== char) add(b);
      for (const t of mj.lines.get(b) ?? []) add(t);
    }
    for (const g of [...out.keys()]) {
      if (!isSingleChar(g)) continue;
      for (const t of mj.lines.get(g) ?? []) add(t);
    }
  } else {
    for (const v of plain) add(v);
  }
  return [...out.entries()]
    .map(([c, m]) => ({ char: c, mj: m }))
    .sort((a, b) => {
      const ca = Array.from(a.char).map((x) => x.codePointAt(0)!);
      const cb = Array.from(b.char).map((x) => x.codePointAt(0)!);
      return ca[0] - cb[0] || ca.length - cb.length || (ca[1] ?? 0) - (cb[1] ?? 0);
    });
}

export function hasAnyVariant(char: string, mj: MjVariantIndex | null): boolean {
  if (VARIANT_INDEX.has(char)) return true;
  if (!mj) return false;
  return mj.lines.has(char) || mj.reverse.has(char);
}

/** Shift_JIS での扱いの説明 */
export function sjisNoteOf(cls: SjisClass | null, ivs = false): string {
  if (ivs) return "異体字セレクタ付き。Shift_JISで保存すると、セレクタが消えて元の字になる";
  if (cls === "basic") return "Shift_JISで使える";
  if (cls === "extension") return "機種依存文字（Windowsの拡張。Mac・古いシステムで文字化けしやすい）";
  if (cls === "none") return "Shift_JISにない（古い業務ソフト・CSVでは外字扱い・文字化けになりやすい）";
  return "Shift_JISで使えるかは判定できませんでした";
}

/** 表示に必要な書体の短い表示 */
export function fontLabel(font: VariantChar["font"]): string | null {
  if (font === "ipamj") return "IPAmj明朝で正しい形";
  if (font === "maybe") return "書体によっては□";
  return null;
}

/** 一覧に出す短い表示（意味は sjisNoteOf） */
export function shortSjisLabel(cls: SjisClass | null, ivs = false): string {
  if (ivs) return "異体字セレクタ付き";
  if (cls === "basic") return "Shift_JISで使える";
  if (cls === "extension") return "機種依存文字";
  if (cls === "none") return "Shift_JISにない";
  return "判定できません";
}

function toVariantChar(v: { char: string; mj: string | null }): VariantChar {
  const cps = Array.from(v.char).map((c) => c.codePointAt(0)!);
  return {
    char: v.char,
    hex: cps.map(formatCodePoint).join(" "),
    sjis: sjisClassOf(cps[0]),
    ivs: cps.length > 1,
    mj: v.mj,
    font: cps.length > 1 ? "ipamj" : sjisClassOf(cps[0]) === "basic" || sjisClassOf(cps[0]) === "extension" ? "standard" : "maybe",
  };
}

/**
 * 入力の中で、形違いの字がある文字を、出てきた順に一覧にする。
 * mj（MJ縮退マップ）を渡すと、戸籍・住民基本台帳などの字も含める。
 */
export function findVariantChars(units: { label: string; text: string }[], mj: MjVariantIndex | null = null): VariantFinding[] {
  const found = new Map<string, VariantFinding>();
  const none = new Set<string>();
  for (const unit of units) {
    for (const ch of unit.text) {
      if (none.has(ch) || !hasAnyVariant(ch, mj)) continue;
      let f = found.get(ch);
      if (!f) {
        const variants = collectVariants(ch, mj).map(toVariantChar);
        if (variants.length === 0) {
          none.add(ch);
          continue;
        }
        f = { char: ch, hex: formatCodePoint(ch.codePointAt(0)!), variants, count: 0, locations: [] };
        found.set(ch, f);
      }
      f.count += 1;
      if (f.locations.length < VARIANT_SAMPLE_LOCATIONS && !f.locations.includes(unit.label)) f.locations.push(unit.label);
    }
  }
  return [...found.values()];
}
