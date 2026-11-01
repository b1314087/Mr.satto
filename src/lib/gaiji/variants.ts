import { formatCodePoint, sjisClassOf, type SjisClass } from "./detect";

/**
 * 異体字（形の違う同じ字）の一覧。
 *
 * 「高橋」と入力しても、名簿や戸籍では「髙橋」（はしご高）で登録されていることがある。
 * 入力した文字に、名前でよく使われる形違いの字があれば、それも一覧に出す
 * （検索・照合で一致しない原因の確認や、正しい字のコピーに使う）。
 *
 * - 名前・地名でよく使われるものを集めた、このサイトの組み込みの一覧（すべての異体字を網羅するものではない）
 * - 会社や自治体が独自に作った外字（私用領域の文字）は、作った所ごとに違うため、一覧にはない
 * - 同じ文字コードのまま形だけを変える「異体字セレクタ（IVS）」の字形は、一覧に含めない
 * - 1行が1つのまとまり（どの文字を入力しても、同じ行の他の文字を出す）
 */
const VARIANT_GROUPS_SOURCE = `
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

/** 文字 → 同じまとまりの文字（自分を含む、一覧の順） */
const VARIANT_INDEX: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const line of VARIANT_GROUPS_SOURCE.split("\n")) {
    const chars = Array.from(new Set(Array.from(line.trim())));
    if (chars.length < 2) continue;
    for (const c of chars) {
      const prev = map.get(c) ?? [];
      map.set(c, Array.from(new Set([...prev, ...chars])));
    }
  }
  return map;
})();

export interface VariantChar {
  char: string;
  hex: string;
  /** Shift_JIS での扱い（判定できない環境では null） */
  sjis: SjisClass | null;
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

export function variantsOf(char: string): string[] {
  return (VARIANT_INDEX.get(char) ?? []).filter((c) => c !== char);
}

/** Shift_JIS での扱いの説明 */
export function sjisNoteOf(cls: SjisClass | null): string {
  if (cls === "basic") return "Shift_JISで使える";
  if (cls === "extension") return "機種依存文字（Windowsの拡張。Mac・古いシステムで文字化けしやすい）";
  if (cls === "none") return "Shift_JISにない（古い業務ソフト・CSVでは外字扱い・文字化けになりやすい）";
  return "Shift_JISで使えるかは判定できませんでした";
}

/** 入力の中で、形違いの字がある文字を、出てきた順に一覧にする */
export function findVariantChars(units: { label: string; text: string }[]): VariantFinding[] {
  const found = new Map<string, VariantFinding>();
  for (const unit of units) {
    for (const ch of unit.text) {
      if (!VARIANT_INDEX.has(ch)) continue;
      let f = found.get(ch);
      if (!f) {
        f = {
          char: ch,
          hex: formatCodePoint(ch.codePointAt(0)!),
          variants: variantsOf(ch).map((v) => ({ char: v, hex: formatCodePoint(v.codePointAt(0)!), sjis: sjisClassOf(v.codePointAt(0)!) })),
          count: 0,
          locations: [],
        };
        found.set(ch, f);
      }
      f.count += 1;
      if (f.locations.length < VARIANT_SAMPLE_LOCATIONS && !f.locations.includes(unit.label)) f.locations.push(unit.label);
    }
  }
  return [...found.values()];
}
