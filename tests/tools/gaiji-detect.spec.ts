import { test, expect } from "@playwright/test";
import {
  CATEGORY_INFO,
  CATEGORY_ORDER,
  classifyCodePoint,
  cleanText,
  DEFAULT_CLEAN_OPTIONS,
  formatCodePoint,
  getSjisTable,
  scanUnits,
  sjisClassOf,
  unitsFromText,
  type CleanOptions,
} from "../../src/lib/gaiji/detect";

/** 外字・特殊文字チェックの判定ロジックの単体テスト（ブラウザ不要）。文字の範囲による判定であり、実際の表示可否は判定しない。 */

const cat = (s: string, checkShiftJis = true) => classifyCodePoint(s.codePointAt(0)!, { checkShiftJis });

test("gaiji: ふつうの文字（ひらがな・カタカナ・漢字・全角記号・英数字・長音）は問題なしと判定する", () => {
  for (const ch of ["A", "z", "0", " ", "あ", "ア", "漢", "字", "ー", "。", "、", "！", "Ａ", "１", "～", "（", "　", "神"]) {
    expect(cat(ch), `${ch} ${formatCodePoint(ch.codePointAt(0)!)}`).toBeNull();
  }
  expect(cat("\t")).toBeNull();
  expect(cat("\n")).toBeNull();
});

test("gaiji: 私用領域の文字（外字）を、基本多言語面・補助面とも検出する", () => {
  expect(cat("")).toBe("private-use");
  expect(cat("")).toBe("private-use");
  expect(cat(String.fromCodePoint(0xf0000))).toBe("private-use");
  expect(cat(String.fromCodePoint(0x10fffd))).toBe("private-use");
  // Shift_JISの確認をオフにしても、外字は検出する
  expect(cat("", false)).toBe("private-use");
  expect(CATEGORY_INFO["private-use"].severity).toBe("high");
});

test("gaiji: 文字化けの跡・制御文字は「要確認」", () => {
  expect(cat("�")).toBe("replacement");
  expect(cat("〓")).toBe("replacement");
  expect(cat("\u0000")).toBe("control");
  expect(cat("\u0007")).toBe("control");
  expect(cat("\u007f")).toBe("control");
  expect(cat("\u0085")).toBe("control");
  expect(CATEGORY_INFO.replacement.severity).toBe("high");
  expect(CATEGORY_INFO.control.severity).toBe("high");
});

test("gaiji: 不可視の文字・特殊な空白・結合文字・異体字セレクタ", () => {
  expect(cat("​")).toBe("invisible");
  expect(cat("﻿")).toBe("invisible");
  expect(cat("­")).toBe("invisible");
  expect(cat("⁠")).toBe("invisible");
  expect(cat(" ")).toBe("unusual-space");
  expect(cat(" ")).toBe("unusual-space");
  expect(cat(" ")).toBe("unusual-space");
  expect(cat("゙")).toBe("combining");
  expect(cat("゚")).toBe("combining");
  expect(cat("́")).toBe("combining");
  expect(cat("︀")).toBe("variation-selector");
  expect(cat(String.fromCodePoint(0xe0100))).toBe("variation-selector");
  // 全角スペースは、ふつうの空白として扱う
  expect(cat("　")).toBeNull();
});

test("gaiji: 互換漢字・補助面の文字・絵文字", () => {
  expect(cat("﨑")).toBe("compat-ideograph"); // 﨑
  expect(cat("豈")).toBe("compat-ideograph");
  expect(cat("⽇")).toBe("radical"); // 康熙部首（「日」にそっくり）
  expect(cat("⺟")).toBe("radical"); // CJK部首補助
  expect(cat("𠮷")).toBe("supplementary");
  expect(cat("𩸽")).toBe("supplementary");
  expect(cat("😀")).toBe("emoji");
  expect(cat("❤")).toBe("emoji");
  expect(cat("✨")).toBe("emoji");
  // 絵文字はShift_JISの確認をオフにしても検出する
  expect(cat("😀", false)).toBe("emoji");
});

test("gaiji: Shift_JIS（Windows系）の機種依存文字・保存できない文字・別の文字に変わる文字・半角カナ", () => {
  expect(getSjisTable()).not.toBeNull();
  // 機種依存文字（NEC・IBMの拡張の領域）
  expect(cat("①")).toBe("ext-dep");
  expect(cat("Ⅰ")).toBe("ext-dep");
  expect(cat("㈱")).toBe("ext-dep");
  expect(cat("㌔")).toBe("ext-dep");
  expect(cat("髙")).toBe("ext-dep"); // はしご高（人名で多い）
  expect(cat("纊")).toBe("ext-dep");
  // 標準の範囲の文字は、問題なし
  expect(sjisClassOf("漢".codePointAt(0)!)).toBe("basic");
  expect(sjisClassOf("①".codePointAt(0)!)).toBe("extension");
  expect(sjisClassOf("é".codePointAt(0)!)).toBe("none");
  // 保存できない文字
  expect(cat("é")).toBe("not-sjis");
  expect(cat("한")).toBe("not-sjis");
  // 変換で別の文字に変わる有名な文字
  expect(cat("〜")).toBe("sjis-mismatch"); // 波ダッシュ U+301C
  expect(cat("−")).toBe("sjis-mismatch"); // U+2212
  expect(cat("‖")).toBe("sjis-mismatch");
  expect(cat("—")).toBe("sjis-mismatch");
  expect(cat("～")).toBeNull(); // 全角チルダ U+FF5E はWindows系で安全
  // 半角カナ
  expect(cat("ｱ")).toBe("halfwidth-kana");
  expect(cat("ﾞ")).toBe("halfwidth-kana");
  // Shift_JISの確認をオフにすると、これらは問題にしない
  for (const ch of ["①", "髙", "é", "〜", "ｱ"]) expect(cat(ch, false), ch).toBeNull();
});

test("gaiji: 各分類に、説明・対処・重要度が定義され、並び順の一覧と一致している", () => {
  const ids = Object.keys(CATEGORY_INFO).sort();
  expect([...CATEGORY_ORDER].sort()).toEqual(ids);
  for (const id of ids) {
    const info = CATEGORY_INFO[id as keyof typeof CATEGORY_INFO];
    expect(info.label.length, id).toBeGreaterThan(0);
    expect(info.summary.length, id).toBeGreaterThan(5);
    expect(info.advice.length, id).toBeGreaterThan(10);
    expect(["high", "mid", "low"]).toContain(info.severity);
  }
});

test("gaiji: 走査は、場所・件数・重要度順を返し、問題のない文字は結果に出さない", () => {
  const text = ["山田太郎", "髙橋​花子", "佐藤次郎", "ﾀﾅｶ ①"].join("\n");
  const r = scanUnits(unitsFromText(text));
  expect(r.totalUnits).toBe(4);
  expect(r.totalChars).toBe(Array.from(text.replace(/\n/g, "")).length);
  const cats = r.findings.map((f) => f.category);
  // 重要度順（要確認→注意→参考）
  expect(cats[0]).toBe("private-use");
  expect(r.findings.map((f) => f.severity)).toEqual([...r.findings.map((f) => f.severity)].sort((a, b) => ({ high: 0, mid: 1, low: 2 })[a] - ({ high: 0, mid: 1, low: 2 })[b]));
  const zw = r.findings.find((f) => f.codePoint === 0x200b)!;
  expect(zw.count).toBe(1);
  expect(zw.locations).toEqual(["2行目（3文字目）"]);
  expect(zw.name).toBe("ゼロ幅スペース");
  const takashi = r.findings.find((f) => f.char === "髙")!;
  expect(takashi.category).toBe("ext-dep");
  expect(takashi.locations).toEqual(["2行目（1文字目）"]);
  const kana = r.findings.filter((f) => f.category === "halfwidth-kana");
  expect(kana.map((f) => f.char).sort()).toEqual(["ﾀ", "ﾅ", "ｶ"].sort());
  expect(r.findings.some((f) => f.char === "山")).toBe(false);
  expect(r.byCategory["private-use"]).toBe(1);
});

test("gaiji: 同じ文字が多いときは、件数は数え、場所の例は6件までにする", () => {
  const text = "​".repeat(20);
  const r = scanUnits(unitsFromText(text));
  expect(r.findings).toHaveLength(1);
  expect(r.findings[0].count).toBe(20);
  expect(r.findings[0].locations).toHaveLength(6);
  expect(r.findings[0].moreLocations).toBe(true);
});

test("gaiji: 空のテキスト・問題のないテキストは、結果が空", () => {
  expect(scanUnits(unitsFromText("")).findings).toEqual([]);
  expect(scanUnits(unitsFromText("これは問題のない文章です。ABC123\nもう1行")).findings).toEqual([]);
});

test("gaiji: 結合した濁点（か+゛）は、見た目が同じでも検出する", () => {
  const decomposed = "が"; // 「が」に見える
  const r = scanUnits(unitsFromText(`${decomposed}ぎ`));
  expect(r.findings.map((f) => f.category)).toEqual(["combining"]);
  expect(r.findings[0].locations[0]).toBe("1行目（2文字目）");
});

test("gaiji: 整えたテキスト（不可視の削除・空白・濁点の合成・互換文字）", () => {
  const all: CleanOptions = { ...DEFAULT_CLEAN_OPTIONS, replaceMismatch: true };
  const input = "a​b c が ﾊﾞﾅﾅ ①㈱ 〜 髙";
  const r = cleanText(input, all);
  expect(r.text).toBe("ab c が バナナ 1(株) ～ 髙");
  expect(r.invisibleRemoved).toBe(1);
  expect(r.spacesReplaced).toBe(1);
  expect(r.combiningComposed).toBe(1);
  expect(r.compatReplaced).toBeGreaterThanOrEqual(5);
  expect(r.mismatchReplaced).toBe(1);
  // 置き換えられない外字・機種依存文字（髙）は、そのまま残し、残った数を知らせる
  expect(r.remainingProblemChars).toBe(2);
});

test("gaiji: 整えたテキストは、オフにした操作をしない。絵文字をつなぐゼロ幅接合子は残す", () => {
  const none: CleanOptions = { removeInvisible: false, normalizeSpaces: false, composeCombining: false, replaceCompat: false, replaceMismatch: false };
  const s = "a​ が①〜";
  expect(cleanText(s, none).text).toBe(s);
  const family = "👨‍👩";
  expect(cleanText(family, { ...DEFAULT_CLEAN_OPTIONS }).text).toBe(family);
  // 日本語の文では、ゼロ幅接合子を取り除く
  expect(cleanText("あ‍い", DEFAULT_CLEAN_OPTIONS).text).toBe("あい");
});

test("gaiji: 康熙部首は、見た目が同じ普通の漢字に置き換える", () => {
  const r = cleanText("⽇⽉⾦曜", DEFAULT_CLEAN_OPTIONS);
  expect(r.text).toBe("日月金曜");
  expect(r.compatReplaced).toBe(3);
  expect(r.remainingProblemChars).toBe(0);
});

test("gaiji: 整えたテキストは、互換漢字・補助面・外字を勝手に別の文字にしない", () => {
  const s = "﨑𠮷";
  expect(cleanText(s, DEFAULT_CLEAN_OPTIONS).text).toBe(s);
});
