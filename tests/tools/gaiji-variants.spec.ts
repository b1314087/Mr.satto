import { test, expect } from "../fixtures/premium-test";
import { buildMjVariantIndex, collectVariants, findVariantChars, variantsOf } from "@/lib/gaiji/variants";
import { MJ_VARIANT_DATA } from "@/lib/gaiji/mj-variant-data";
import { VARIANT_GROUPS_DATA } from "@/lib/gaiji/variant-data";

/** 形の違う字（異体字）の一覧（単体） */

test.describe("異体字の一覧", () => {
  test("どの字から引いても、同じまとまりの他の字が出る", () => {
    expect(variantsOf("高")).toEqual(["髙"]);
    expect(variantsOf("髙")).toEqual(["高"]);
    expect(variantsOf("崎")).toEqual(["埼", "嵜", "碕", "﨑"]);
    expect(variantsOf("嵜")).toEqual(["埼", "崎", "碕", "﨑"]);
    expect(variantsOf("寝")).toEqual(["寢"]);
    expect(variantsOf("辺")).toEqual(["邉", "邊"]);
    expect(variantsOf("斉")).toContain("齋");
    expect(variantsOf("吉")).toEqual(["𠮷"]);
    expect(variantsOf("𠮷")).toEqual(["吉"]);
    expect(variantsOf("山")).toEqual([]);
  });

  test("一覧の字は、Unicodeの正規化（NFC）で別の字に変わらない（貼り付けで化けない）", () => {
    for (const ch of ["高", "髙", "﨑", "𠮷", "邉", "槗", "濵", "德", "寝", "国", "学"]) {
      expect(ch.normalize("NFC")).toBe(ch);
      for (const v of variantsOf(ch)) expect(v.normalize("NFC"), `${ch}→${v}`).toBe(v);
    }
  });

  test("公開データの一覧：2,000字以上を含み、すべて漢字1文字で、正規化で変わらない", () => {
    const chars = Array.from(new Set(Array.from(VARIANT_GROUPS_DATA.replace(/\s+/g, ""))));
    expect(chars.length).toBeGreaterThan(2000);
    for (const c of chars) {
      expect(c.normalize("NFC"), c).toBe(c);
      expect(/\p{Script=Han}/u.test(c), c).toBe(true);
      expect(variantsOf(c).length, c).toBeGreaterThan(0);
    }
  });

  test("入力の中から、出てきた順・件数・場所つきで一覧にする（補助面の字も1文字として数える）", () => {
    const r = findVariantChars([
      { label: "1行目", text: "𠮷田 高橋" },
      { label: "2行目", text: "高田" },
    ]);
    expect(r.map((f) => f.char)).toEqual(["𠮷", "高", "橋"]);
    expect(r[0].hex).toBe("U+20BB7");
    expect(r[1]).toMatchObject({ count: 2, locations: ["1行目", "2行目"] });
    expect(r[1].variants.map((v) => v.char)).toEqual(["髙"]);
  });

  test("戸籍などの字（MJ縮退マップ）：高→髙・𠆪、寝→寢と寢の異体字セレクタ付き、辺→邉の異体字セレクタ付き（2段目）", () => {
    const mj = buildMjVariantIndex(MJ_VARIANT_DATA);
    expect(mj.lines.size).toBeGreaterThan(8000);
    const taka = collectVariants("高", mj).map((v) => v.char);
    expect(taka).toEqual(expect.arrayContaining(["髙", "𠆪"]));
    // 髙から引いても高が出る（その字を形違いに持つ元の字）
    expect(collectVariants("髙", mj).map((v) => v.char)).toContain("高");
    const ne = collectVariants("寝", mj).map((v) => v.char);
    expect(ne).toEqual(expect.arrayContaining(["寢", "寑", "㝲"]));
    expect(ne.some((c) => Array.from(c).length === 2 && c.startsWith("寢"))).toBe(true);
    const be = collectVariants("辺", mj);
    expect(be.find((v) => v.char === "辺\u{E0102}")?.mj).toBe("MJ025759");
    expect(be.filter((v) => v.char.startsWith("邉") && v.mj).length).toBeGreaterThan(10);
    // 入力した字そのもの（異体字セレクタなし）は出さない
    expect(be.map((v) => v.char)).not.toContain("辺");
    // データの字は、異体字セレクタ以外、正規化（NFC）で変わらない
    const changed: string[] = [];
    for (const [base, tokens] of mj.lines) {
      if (base.normalize("NFC") !== base) changed.push(base);
      for (const t of tokens) {
        const g = t.split("#")[0];
        if (g.normalize("NFC") !== g) changed.push(g);
      }
    }
    expect(changed).toEqual([]);
  });

  test("戸籍などの字を使うと、異体字セレクタ付きの字は ivs・MJ番号つきで出る", () => {
    const mj = buildMjVariantIndex(MJ_VARIANT_DATA);
    const r = findVariantChars([{ label: "1行目", text: "辺" }], mj);
    const v = r[0].variants.find((x) => x.mj === "MJ025759")!;
    expect(v).toMatchObject({ ivs: true, hex: "U+8FBA U+E0102", sjis: "basic" });
  });
});
