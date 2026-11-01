import { test, expect } from "../fixtures/premium-test";
import { findVariantChars, variantsOf } from "@/lib/gaiji/variants";

/** 形の違う字（異体字）の一覧（単体） */

test.describe("異体字の一覧", () => {
  test("どの字から引いても、同じまとまりの他の字が出る", () => {
    expect(variantsOf("高")).toEqual(["髙"]);
    expect(variantsOf("髙")).toEqual(["高"]);
    expect(variantsOf("崎")).toEqual(["﨑", "嵜", "碕"]);
    expect(variantsOf("嵜")).toEqual(["崎", "﨑", "碕"]);
    expect(variantsOf("吉")).toEqual(["𠮷"]);
    expect(variantsOf("𠮷")).toEqual(["吉"]);
    expect(variantsOf("山")).toEqual([]);
  });

  test("一覧の字は、Unicodeの正規化（NFC）で別の字に変わらない（貼り付けで化けない）", () => {
    for (const ch of ["高", "髙", "﨑", "𠮷", "邉", "槗", "濵", "德"]) {
      expect(ch.normalize("NFC")).toBe(ch);
      for (const v of variantsOf(ch)) expect(v.normalize("NFC"), `${ch}→${v}`).toBe(v);
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
});
