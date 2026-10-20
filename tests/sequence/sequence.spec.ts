import { test, expect } from "@playwright/test";
import {
  SEQUENCE_MAX_LINES,
  formatNumber,
  formatSequenceLabel,
  generateMultiple,
  generateSingle,
  parseSequenceNumber,
  toClipboardText,
  type SequenceStyle,
  type SequenceWidth,
} from "@/lib/sequence/sequence";

/**
 * 連番・項目一括生成の計算ロジックの単体テスト。期待値はこのファイルに直接書き、実装から作らない。
 * 区切りは全角スペース（U+3000）。
 */

const SP = "　";
const single = (over: Partial<Parameters<typeof generateSingle>[0]> = {}) =>
  generateSingle({ item: "英語", start: "1", end: "10", style: "dai-kai", width: "full", ...over });
const multi = (text: string, style: SequenceStyle = "dai-kai", width: SequenceWidth = "full") => generateMultiple({ text, style, width });

test.describe("番号の表示", () => {
  test("全角・半角の数字", () => {
    expect(formatNumber(10, "full")).toBe("１０");
    expect(formatNumber(10, "half")).toBe("10");
    expect(formatNumber(0, "full")).toBe("０");
    expect(formatNumber(9999, "full")).toBe("９９９９");
  });

  test("第○回 / ○回目 / ○", () => {
    expect(formatSequenceLabel(1, "dai-kai", "full")).toBe("第１回");
    expect(formatSequenceLabel(1, "dai-kai", "half")).toBe("第1回");
    expect(formatSequenceLabel(12, "kai-me", "half")).toBe("12回目");
    expect(formatSequenceLabel(12, "kai-me", "full")).toBe("１２回目");
    expect(formatSequenceLabel(3, "plain", "half")).toBe("3");
    expect(formatSequenceLabel(3, "plain", "full")).toBe("３");
  });
});

test.describe("単一項目", () => {
  test("初期値（英語 / 1〜10 / 第○回 / 全角）: 10行、最初と最後", () => {
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

  test("表示形式・全角半角の6通り", () => {
    const cases: [SequenceStyle, SequenceWidth, string][] = [
      ["dai-kai", "full", `第１回${SP}英語`],
      ["dai-kai", "half", `第1回${SP}英語`],
      ["kai-me", "full", `１回目${SP}英語`],
      ["kai-me", "half", `1回目${SP}英語`],
      ["plain", "full", `１${SP}英語`],
      ["plain", "half", `1${SP}英語`],
    ];
    for (const [style, width, first] of cases) {
      const r = single({ style, width, end: "2" });
      expect(r.lines[0], `${style}/${width}`).toBe(first);
      expect(r.lines).toHaveLength(2);
    }
  });

  test("開始番号が終了番号より大きいときは、逆順にせずエラーで案内する", () => {
    const r = single({ start: "5", end: "3" });
    expect(r.lines).toEqual([]);
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
    const r = multi("C\nA\nB\nA\nC\nC\nB\nA");
    expect(r.lines.map((l) => l.split(SP)[1])).toEqual(["C", "A", "B", "A", "C", "C", "B", "A"]);
    expect(r.lines.map((l) => l.split(SP)[0])).toEqual(["第１回", "第１回", "第１回", "第２回", "第２回", "第３回", "第２回", "第３回"]);
  });

  test("空行・空白だけの行は出さず、番号も進めない。改行コードの違いも読める", () => {
    const r = multi("英語\n\n  \n　\n英語\r\n\r\n国語\r英語");
    expect(r.lines).toEqual([`第１回${SP}英語`, `第２回${SP}英語`, `第１回${SP}国語`, `第３回${SP}英語`]);
    expect(r.skippedBlankLines).toBe(4);
  });

  test("項目名の前後の空白（全角空白も）は無視して同じ項目として数える。大文字小文字・全角半角は区別する", () => {
    const r = multi("英語\n 英語 \n　英語　\nEnglish\nenglish\nＡＢ\nAB");
    expect(r.lines.map((l) => l.split(SP)[0])).toEqual(["第１回", "第２回", "第３回", "第１回", "第１回", "第１回", "第１回"]);
  });

  test("空の入力・空行だけの入力は、案内を返す", () => {
    for (const text of ["", "\n\n", "   \n　\n"]) {
      const r = multi(text);
      expect(r.lines).toEqual([]);
      expect(r.error).toBe("項目を1行に1つずつ入力してください");
    }
  });

  test("表示形式・全角半角を切り替えても、項目と順序・件数・番号の値は変わらない", () => {
    const text = "英語\n英語\n国語\n英語\n数学\n国語\n英語";
    const base = multi(text, "dai-kai", "half").lines.map((l) => l.split(SP));
    const numbers = (label: string) => Number(label.normalize("NFKC").replace(/\D/g, ""));
    for (const style of ["dai-kai", "kai-me", "plain"] as const) {
      for (const width of ["full", "half"] as const) {
        const rows = multi(text, style, width).lines.map((l) => l.split(SP));
        expect(rows.map((r) => r[1]), `${style}/${width} 項目`).toEqual(base.map((r) => r[1]));
        expect(rows.map((r) => numbers(r[0])), `${style}/${width} 番号`).toEqual(base.map((r) => numbers(r[0])));
      }
    }
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
