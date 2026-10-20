import { test, expect } from "@playwright/test";
import {
  DEFAULT_TEMPLATE,
  SEQUENCE_MAX_LINES,
  TEMPLATE_EXAMPLES,
  TEMPLATE_MAX_LENGTH,
  applyTemplate,
  checkTemplate,
  formatNumber,
  generateMultiple,
  generateSingle,
  parseSequenceNumber,
  toClipboardText,
  type SequenceWidth,
} from "@/lib/sequence/sequence";

/**
 * 連番・項目一括生成の計算ロジックの単体テスト。期待値はこのファイルに直接書き、実装から作らない。
 * 初期テンプレートの区切りは全角スペース（U+3000）。
 */

const SP = "　";
const single = (over: Partial<Parameters<typeof generateSingle>[0]> = {}) =>
  generateSingle({ item: "英語", start: "1", end: "10", template: DEFAULT_TEMPLATE, width: "full", ...over });
const multi = (text: string, template: string = DEFAULT_TEMPLATE, width: SequenceWidth = "full") => generateMultiple({ text, template, width });

test.describe("テンプレートの置き換え", () => {
  test("初期値は「第{n}回　{item}」", () => {
    expect(DEFAULT_TEMPLATE).toBe(`第{n}回${SP}{item}`);
    expect(TEMPLATE_EXAMPLES).toContain(DEFAULT_TEMPLATE);
  });

  test("全角・半角の数字（番号だけが変換される）", () => {
    expect(formatNumber(10, "full")).toBe("１０");
    expect(formatNumber(10, "half")).toBe("10");
    expect(formatNumber(0, "full")).toBe("０");
    expect(formatNumber(9999, "full")).toBe("９９９９");
    // 項目名やテンプレートの数字・英字は変換しない
    expect(applyTemplate("第{n}回 {item}123", "ABC456", 7, "full")).toBe("第７回 ABC456123");
    expect(applyTemplate("第{n}回 {item}123", "ABC456", 7, "half")).toBe("第7回 ABC456123");
  });

  test("例のテンプレートが、そのとおりに置き換わる", () => {
    expect(applyTemplate("{n}. {item}", "英語", 3, "half")).toBe("3. 英語");
    expect(applyTemplate("{item}（第{n}回）", "英語", 3, "full")).toBe("英語（第３回）");
    expect(applyTemplate("【{n}】{item}", "英語", 12, "half")).toBe("【12】英語");
    expect(applyTemplate(`{n}回目${SP}{item}`, "国語", 2, "half")).toBe(`2回目${SP}国語`);
    expect(applyTemplate(`{n}${SP}{item}`, "国語", 2, "half")).toBe(`2${SP}国語`);
  });

  test("同じ記号が複数あれば、すべて置き換える。順序は自由", () => {
    expect(applyTemplate("{n}/{n}:{item}={item}", "A", 2, "half")).toBe("2/2:A=A");
    expect(applyTemplate("{item}{n}{item}{n}", "A", 5, "full")).toBe("A５A５");
    expect(applyTemplate("{item}", "A", 5, "full")).toBe("A");
    expect(applyTemplate("{n}", "A", 5, "full")).toBe("５");
  });

  test("置き換えは1回の走査: 項目名の中の「{n}」「$&」などは、そのまま出力される", () => {
    expect(applyTemplate("{item}-{n}", "{n}", 4, "half")).toBe("{n}-4");
    expect(applyTemplate("{n}:{item}", "$& $1 $$", 1, "half")).toBe("1:$& $1 $$");
  });

  test("片方・両方の記号がなくても使える（記号なしは、そのまま繰り返し）", () => {
    const onlyN = single({ template: "No.{n}", end: "2" });
    expect(onlyN.lines).toEqual(["No.１", "No.２"]);
    expect(onlyN.notes).toEqual(["{item} がないため、項目名は出力されません。"]);
    const onlyItem = multi("英語\n国語", "科目：{item}");
    expect(onlyItem.lines).toEqual(["科目：英語", "科目：国語"]);
    expect(onlyItem.notes).toEqual(["{n} がないため、番号は出力されません。"]);
    const none = single({ template: "固定の文字", end: "2" });
    expect(none.lines).toEqual(["固定の文字", "固定の文字"]);
    expect(none.notes).toHaveLength(2);
    expect(single().notes).toEqual([]);
  });

  test("{item} を使わないテンプレートなら、項目名が空でもよい。使うなら空はエラー", () => {
    expect(single({ item: "", template: "{n}", end: "2" }).lines).toEqual(["１", "２"]);
    expect(single({ item: "", template: "{n}{item}" }).error).toBe("項目名を入力してください");
  });
});

test.describe("テンプレートの検査（不正な表記の案内）", () => {
  test("使える書き方はエラーなし", () => {
    for (const t of [DEFAULT_TEMPLATE, "{n}", "{item}", "固定", "{n}{n}", "【{n}】{item}", "{item}（第{n}回）", "a{n}b{item}c", "{ n }".replace(/ /g, "")]) {
      expect(checkTemplate(t).error, t).toBeNull();
    }
    expect(checkTemplate("{n}{item}")).toMatchObject({ hasNumber: true, hasItem: true, notes: [] });
  });

  test("空のテンプレート・改行・長すぎる", () => {
    expect(checkTemplate("").error).toBe("テンプレートを入力してください（例: 第{n}回　{item}）");
    expect(checkTemplate("  　 ").error).toContain("テンプレートを入力してください");
    expect(checkTemplate("{n}\n{item}").error).toBe("テンプレートに改行は入れられません。1行で入力してください");
    expect(checkTemplate("a".repeat(TEMPLATE_MAX_LENGTH)).error).toBeNull();
    expect(checkTemplate("a".repeat(TEMPLATE_MAX_LENGTH + 1)).error).toBe(`テンプレートは${TEMPLATE_MAX_LENGTH}文字までにしてください`);
  });

  test("知らない記号・大文字・日本語の記号名は、直し方を案内する", () => {
    expect(checkTemplate("{x}{item}").error).toBe("「{x}」は使えません。使えるのは {n}（連番）と {item}（項目名）です");
    expect(checkTemplate("{N}").error).toBe("「{N}」は小文字で {n} と書いてください");
    expect(checkTemplate("{Item}").error).toBe("「{Item}」は小文字で {item} と書いてください");
    expect(checkTemplate("{番号}").error).toBe("「{番号}」は使えません。連番は {n} と書いてください");
    expect(checkTemplate("{項目}").error).toBe("「{項目}」は使えません。項目名は {item} と書いてください");
    expect(checkTemplate("{}").error).toContain("「{}」は使えません");
    expect(checkTemplate("{ n }").error).toContain("「{ n }」は使えません");
  });

  test("波かっこの対応が合っていない・全角の波かっこ", () => {
    for (const t of ["{n", "n}", "{{n}}", "{n}}", "{item", "}{n}{"]) {
      expect(checkTemplate(t).error, t).toContain("波かっこ { } の対応が合っていません");
    }
    expect(checkTemplate("｛n｝").error).toContain("全角の波かっこ（｛｝）は使えません");
  });

  test("不正なテンプレートでは、生成せず（両モードとも）テンプレートのエラーを返す", () => {
    for (const r of [single({ template: "{x}" }), multi("英語", "{x}")]) {
      expect(r.lines).toEqual([]);
      expect(r.errorKind).toBe("template");
      expect(r.error).toContain("「{x}」は使えません");
    }
  });
});

test.describe("単一項目", () => {
  test("初期値（英語 / 1〜10 / 第{n}回　{item} / 全角）: 10行、最初と最後", () => {
    const r = single();
    expect(r.error).toBeNull();
    expect(r.lines).toHaveLength(10);
    expect(r.lines[0]).toBe(`第１回${SP}英語`);
    expect(r.lines[1]).toBe(`第２回${SP}英語`);
    expect(r.lines[9]).toBe(`第１０回${SP}英語`);
  });

  test("開始番号・終了番号が反映される（途中からの連番）", () => {
    expect(single({ start: "3", end: "5" }).lines).toEqual([`第３回${SP}英語`, `第４回${SP}英語`, `第５回${SP}英語`]);
    expect(single({ start: "7", end: "7" }).lines).toEqual([`第７回${SP}英語`]);
    expect(single({ start: "0", end: "1" }).lines).toEqual([`第０回${SP}英語`, `第１回${SP}英語`]);
  });

  test("テンプレート × 全角半角の組み合わせ（件数・項目・番号の値は変わらない）", () => {
    const cases: [string, SequenceWidth, string, string][] = [
      [DEFAULT_TEMPLATE, "full", `第１回${SP}英語`, `第２回${SP}英語`],
      [DEFAULT_TEMPLATE, "half", `第1回${SP}英語`, `第2回${SP}英語`],
      ["{n}. {item}", "half", "1. 英語", "2. 英語"],
      ["{n}. {item}", "full", "１. 英語", "２. 英語"],
      ["{item}（第{n}回）", "half", "英語（第1回）", "英語（第2回）"],
      ["【{n}】{item}", "full", "【１】英語", "【２】英語"],
    ];
    for (const [template, width, first, second] of cases) {
      const r = single({ template, width, end: "2" });
      expect(r.lines, `${template}/${width}`).toEqual([first, second]);
    }
  });

  test("開始番号が終了番号より大きいときは、逆順にせずエラーで案内する", () => {
    const r = single({ start: "5", end: "3" });
    expect(r.lines).toEqual([]);
    expect(r.errorKind).toBe("input");
    expect(r.error).toBe("開始番号が終了番号より大きくなっています。開始番号は終了番号以下にしてください");
  });

  test("不正な入力: 項目名が空、番号が空・文字・小数・負の数・範囲外", () => {
    expect(single({ item: "" }).error).toBe("項目名を入力してください");
    expect(single({ item: "  　 " }).error).toBe("項目名を入力してください");
    expect(single({ start: "" }).error).toBe("開始番号を入力してください");
    expect(single({ end: "   " }).error).toBe("終了番号を入力してください");
    expect(single({ start: "abc" }).error).toContain("開始番号は、0以上の整数");
    expect(single({ end: "1.5" }).error).toContain("終了番号は、0以上の整数");
    expect(single({ start: "-1" }).error).toContain("開始番号は、0以上の整数");
    expect(single({ end: "10000" }).error).toBe("終了番号は、0〜9999の範囲で入力してください");
    expect(single({ start: "1e3" }).error).toContain("開始番号は、0以上の整数");
    for (const bad of [{ start: "abc" }, { end: "" }, { item: "" }, { start: "9", end: "1" }]) expect(single(bad).lines).toEqual([]);
  });

  test("全角の数字で入力しても読める。行数の上限を超える範囲はエラー", () => {
    expect(single({ start: "３", end: "４" }).lines).toEqual([`第３回${SP}英語`, `第４回${SP}英語`]);
    expect(single({ start: "1", end: String(SEQUENCE_MAX_LINES) }).lines).toHaveLength(SEQUENCE_MAX_LINES);
    expect(single({ start: "1", end: String(SEQUENCE_MAX_LINES + 1) }).error).toContain("一度に作れるのは2,000行まで");
  });

  test("項目名: 前後の空白は取り除き、改行は空白1つにして1行にする。記号はそのまま", () => {
    expect(single({ item: "  英語  ", end: "1" }).lines).toEqual([`第１回${SP}英語`]);
    const lines = single({ item: "数学\nA", end: "2" }).lines;
    expect(lines).toEqual([`第１回${SP}数学 A`, `第２回${SP}数学 A`]);
    for (const l of lines) expect(l).not.toContain("\n");
    expect(single({ item: `=SUM(A1) "x" <b>&`, end: "1" }).lines[0]).toBe(`第１回${SP}=SUM(A1) "x" <b>&`);
  });

  test("番号の入力の検査（parseSequenceNumber）", () => {
    expect(parseSequenceNumber(" 12 ", "x")).toEqual({ value: 12 });
    expect(parseSequenceNumber("０", "x")).toEqual({ value: 0 });
    expect("error" in parseSequenceNumber("", "x")).toBe(true);
  });
});

test.describe("複数項目", () => {
  test("指示書の例: 英語・英語・国語・英語・数学・国語", () => {
    const r = multi("英語\n英語\n国語\n英語\n数学\n国語");
    expect(r.error).toBeNull();
    expect(r.lines).toEqual([
      `第１回${SP}英語`,
      `第２回${SP}英語`,
      `第１回${SP}国語`,
      `第３回${SP}英語`,
      `第１回${SP}数学`,
      `第２回${SP}国語`,
    ]);
  });

  test("入力順がそのまま出力順になる。離れた行の同じ項目も番号が続く。項目ごとに独立", () => {
    const r = multi("C\nA\nB\nA\nC\nC\nB\nA", "{item}={n}", "half");
    expect(r.lines).toEqual(["C=1", "A=1", "B=1", "A=2", "C=2", "C=3", "B=2", "A=3"]);
  });

  test("自由なテンプレートでも、項目ごとの採番・順序は同じ", () => {
    const text = "英語\n英語\n国語\n英語\n数学\n国語";
    expect(multi(text, "{item}（第{n}回）", "half").lines).toEqual(["英語（第1回）", "英語（第2回）", "国語（第1回）", "英語（第3回）", "数学（第1回）", "国語（第2回）"]);
    expect(multi(text, "【{n}】{item}", "full").lines).toEqual(["【１】英語", "【２】英語", "【１】国語", "【３】英語", "【１】数学", "【２】国語"]);
  });

  test("空行・空白だけの行は出さず、番号も進めない。改行コードの違いも読める", () => {
    const r = multi("英語\n\n  \n　\n英語\r\n\r\n国語\r英語");
    expect(r.lines).toEqual([`第１回${SP}英語`, `第２回${SP}英語`, `第１回${SP}国語`, `第３回${SP}英語`]);
    expect(r.skippedBlankLines).toBe(4);
  });

  test("項目名の前後の空白（全角空白も）は無視して同じ項目として数える。大文字小文字・全角半角は区別する", () => {
    const r = multi("英語\n 英語 \n　英語　\nEnglish\nenglish\nＡＢ\nAB", "{n}", "half");
    expect(r.lines).toEqual(["1", "2", "3", "1", "1", "1", "1"]);
  });

  test("空の入力・空行だけの入力は、案内を返す", () => {
    for (const text of ["", "\n\n", "   \n　\n"]) {
      const r = multi(text);
      expect(r.lines).toEqual([]);
      expect(r.error).toBe("項目を1行に1つずつ入力してください");
      expect(r.errorKind).toBe("input");
    }
  });

  test("全角・半角を切り替えても、項目と順序・件数・番号の値は変わらない", () => {
    const text = "英語\n英語\n国語\n英語\n数学\n国語\n英語";
    const template = "{item}|{n}";
    const base = multi(text, template, "half").lines.map((l) => l.split("|"));
    const full = multi(text, template, "full").lines.map((l) => l.split("|"));
    expect(full.map((r) => r[0])).toEqual(base.map((r) => r[0]));
    expect(full.map((r) => r[1].normalize("NFKC"))).toEqual(base.map((r) => r[1]));
    expect(full[1][1]).toBe("２");
  });

  test("行数の上限と、番号の上限", () => {
    const many = Array.from({ length: SEQUENCE_MAX_LINES }, (_, i) => `項目${i}`).join("\n");
    expect(multi(many).lines).toHaveLength(SEQUENCE_MAX_LINES);
    expect(multi(`${many}\n追加`).error).toContain("一度に作れるのは2,000行まで");
  });

  test("1行に1項目: 出力の各行は改行を含まず、タブも含めない", () => {
    const r = multi("英語\n国語");
    for (const l of r.lines) expect(l).not.toMatch(/[\n\t]/);
  });
});

test.describe("コピー用の文字", () => {
  test("改行をそろえ、末尾の改行は付けない。途中の空行は編集した内容として残す", () => {
    expect(toClipboardText("a\r\nb\r\n\r\n")).toBe("a\nb");
    expect(toClipboardText("a\n\nb\n")).toBe("a\n\nb");
    expect(toClipboardText("")).toBe("");
  });
});
