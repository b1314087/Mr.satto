import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { PasswordGenerateProcessor, estimatePasswordStrength, uniqueChars } from "@/lib/processors/browser/password";

/**
 * パスワード生成の安全性のテスト(ブラウザを使わず、処理そのものを確かめる。Node.js の Web Crypto API は、
 * ブラウザの crypto.getRandomValues と同じ「暗号学的に安全な乱数」)。
 *
 * 確かめること:
 *  - 乱数は crypto.getRandomValues だけを使う(Math.random を使わない)
 *  - 剰余による偏りが出ないよう、範囲外の乱数は引き直す(棄却法)
 *  - 文字の出現が偏らない(カイ二乗検定)・位置による偏りもない
 *  - 選んだ文字種・文字数どおりで、選んでいない文字が入らない。選んだ文字種は必ず1文字以上入る
 *    (足りない文字種を後から差し込むと、その文字種の文字が出やすくなるため、全体を作り直して一様にしている)
 *  - 極端な設定(4文字・128文字・文字種1つ・4つ全部・直接指定2文字・絵文字)でも生成できる
 *  - 強度は、文字種の数ではなく、組み合わせの数(ビット数)で決まる
 */

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*()-_=+[]{}";

const gen = (input: Partial<Parameters<PasswordGenerateProcessor["process"]>[0]> & { length: number }) =>
  new PasswordGenerateProcessor().process({ useUppercase: false, useLowercase: false, useNumbers: false, useSymbols: false, ...input });

/** カイ二乗値(期待値どおりの一様分布からのずれ)。自由度 k-1 */
function chiSquare(counts: Map<string, number>, alphabet: string[], total: number) {
  const expected = total / alphabet.length;
  return alphabet.reduce((sum, ch) => sum + ((counts.get(ch) ?? 0) - expected) ** 2 / expected, 0);
}

/** 自由度 df のカイ二乗分布の上側 0.1% 点の近似(Wilson–Hilferty)。これを超えたら「偏りがある」と判定する */
function chiCritical(df: number, z = 3.09) {
  return df * (1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df))) ** 3;
}

test("乱数：crypto.getRandomValues だけを使い、Math.random は使わない(処理のコードにも Math.random が無い)", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "lib", "processors", "browser", "password.ts"), "utf-8");
  expect(source).not.toMatch(/Math\.random/);
  expect(source).toMatch(/crypto\.getRandomValues/);
  const originalRandom = Math.random;
  const originalGet = crypto.getRandomValues.bind(crypto);
  let calls = 0;
  Math.random = () => {
    throw new Error("Math.random が呼ばれた");
  };
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(a: T) => {
    calls++;
    return originalGet(a as never) as T;
  }) as typeof crypto.getRandomValues;
  try {
    await gen({ length: 32, useUppercase: true, useLowercase: true, useNumbers: true, useSymbols: true });
    await gen({ length: 16, customChars: "abc" });
    expect(calls).toBeGreaterThanOrEqual(48);
  } finally {
    Math.random = originalRandom;
    crypto.getRandomValues = originalGet;
  }
});

test("偏りの防止：範囲外の乱数(剰余で偏る部分)は捨てて引き直す", async () => {
  // 文字が3種類のとき、2^32 を3で割り切れる最大の値(4294967295 = 3×1431655765)以上は捨てる。
  // 1回目に 0xFFFFFFFF(捨てる値)、2回目に 4(→ 4 % 3 = 1 → "b")を返す乱数で確かめる
  const queue = [0xffffffff, 4, 0xffffffff, 0xffffffff, 3, 5, 6, 7];
  const originalGet = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(a: T) => {
    (a as unknown as Uint32Array)[0] = queue.shift() ?? 0;
    return a;
  }) as typeof crypto.getRandomValues;
  try {
    const { password } = await gen({ length: 4, customChars: "abc" });
    // 4 → b、(捨てる・捨てる)3 → a、5 → c、6 → a
    expect(password).toBe("baca");
  } finally {
    crypto.getRandomValues = originalGet;
  }
});

test("文字の出現の偏り：文字種4つ・直接指定・数字だけで、各文字の出現回数が一様(カイ二乗検定・有意水準0.1%)", async () => {
  test.setTimeout(60_000);
  const cases = [
    { label: "文字種4つ", input: { length: 64, useUppercase: true, useLowercase: true, useNumbers: true, useSymbols: true }, alphabet: UPPER + LOWER + DIGITS + SYMBOLS },
    { label: "数字だけ", input: { length: 64, useNumbers: true }, alphabet: DIGITS },
    { label: "直接指定(7文字)", input: { length: 64, customChars: "aあ1!Zz😀" }, alphabet: "aあ1!Zz😀" },
  ];
  for (const c of cases) {
    const alphabet = Array.from(c.alphabet);
    const counts = new Map<string, number>();
    let total = 0;
    for (let i = 0; i < 2000; i++) {
      const { password } = await gen(c.input);
      for (const ch of Array.from(password)) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
        total++;
      }
    }
    // 使ってよい文字だけが出る
    for (const ch of counts.keys()) expect(alphabet, `${c.label}：使わない文字「${ch}」が出た`).toContain(ch);
    const x2 = chiSquare(counts, alphabet, total);
    expect(x2, `${c.label}：偏りがある(χ²=${x2.toFixed(1)}, 上限 ${chiCritical(alphabet.length - 1).toFixed(1)})`).toBeLessThan(chiCritical(alphabet.length - 1));
  }
});

test("位置による偏り：文字種4つで、各文字種の出やすさがどの位置でも同じ・文字種の中の各文字も一様", async () => {
  test.setTimeout(60_000);
  const length = 16;
  const sets = [UPPER, LOWER, DIGITS, SYMBOLS];
  const byPos = Array.from({ length }, () => [0, 0, 0, 0]);
  const inSet = sets.map(() => new Map<string, number>());
  const n = 4000;
  for (let i = 0; i < n; i++) {
    const { password } = await gen({ length, useUppercase: true, useLowercase: true, useNumbers: true, useSymbols: true });
    Array.from(password).forEach((ch, p) => {
      const k = sets.findIndex((s) => s.includes(ch));
      byPos[p][k]++;
      inSet[k].set(ch, (inSet[k].get(ch) ?? 0) + 1);
    });
  }
  // 「選んだ文字種がすべて入るパスワード」の中から一様に選ぶため、少ない文字種(数字)は全体の文字の数の比より少し多く
  // 出る(数学的にそうなる)。大事なのは、その割合が位置によって変わらないこと(特定の位置に特定の文字種が偏らない)
  sets.forEach((_, k) => {
    const ratios = byPos.map((row) => row[k] / n);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    expect(spread, `文字種${k}：位置による割合の差 ${spread.toFixed(3)}`).toBeLessThan(0.04);
  });
  // 同じ文字種の中では、どの文字も同じように出る
  sets.forEach((s, k) => {
    const alphabet = Array.from(s);
    const total = [...inSet[k].values()].reduce((a, v) => a + v, 0);
    const x2 = chiSquare(inSet[k], alphabet, total);
    expect(x2, `文字種${k}：文字の偏り χ²=${x2.toFixed(1)}`).toBeLessThan(chiCritical(alphabet.length - 1));
  });
});

test("文字種・文字数：選んだ文字種だけ・指定した長さどおり・選んだ文字種は必ず1文字以上(すべての組み合わせ×極端な長さ)", async () => {
  const keys = ["useUppercase", "useLowercase", "useNumbers", "useSymbols"] as const;
  const sets = { useUppercase: UPPER, useLowercase: LOWER, useNumbers: DIGITS, useSymbols: SYMBOLS };
  for (let mask = 1; mask < 16; mask++) {
    const chosen = keys.filter((_, i) => mask & (1 << i));
    const allowed = chosen.map((k) => sets[k]).join("");
    for (const length of [4, 5, 12, 64, 128]) {
      for (let r = 0; r < 30; r++) {
        const input = { length, ...Object.fromEntries(chosen.map((k) => [k, true])) };
        const { password } = await gen(input);
        expect(Array.from(password)).toHaveLength(length);
        for (const ch of password) expect(allowed).toContain(ch);
        for (const k of chosen) expect(Array.from(password).some((ch) => sets[k].includes(ch)), `${k} が入っていない`).toBe(true);
      }
    }
  }
});

test("極端な設定・入力の確認：長さの範囲外・文字種なし・直接指定1種類はエラー、直接指定2文字・絵文字・空白入りは使える", async () => {
  await expect(gen({ length: 3, useNumbers: true })).rejects.toThrow("4〜128文字");
  await expect(gen({ length: 129, useNumbers: true })).rejects.toThrow("4〜128文字");
  await expect(gen({ length: 8 })).rejects.toThrow("1つ以上選ぶ");
  await expect(gen({ length: 8, customChars: "aaa  " })).rejects.toThrow("2種類以上");
  const two = await gen({ length: 128, customChars: "01" });
  expect(two.password).toMatch(/^[01]{128}$/);
  const emoji = await gen({ length: 10, customChars: "😀🎉 a\nb" });
  expect(Array.from(emoji.password)).toHaveLength(10);
  for (const ch of Array.from(emoji.password)) expect(["😀", "🎉", "a", "b"]).toContain(ch);
  // 直接指定すると、チェックボックスの文字種は使わない
  const custom = await gen({ length: 50, customChars: "xy", useUppercase: true, useNumbers: true });
  expect(custom.password).toMatch(/^[xy]{50}$/);
  expect(uniqueChars("aa bb\tcc")).toEqual(["a", "b", "c"]);
});

test("強度：文字種の数ではなく、組み合わせの数(長さ×log2(文字の種類の数))で決まる", async () => {
  // 4文字は、文字種を4つ選んでも「とても弱い」(約25ビット)
  expect((await gen({ length: 4, useUppercase: true, useLowercase: true, useNumbers: true, useSymbols: true })).strength).toBe(0);
  // 数字だけでも128文字なら「とても強い」(約384ビット)
  expect((await gen({ length: 128, useNumbers: true })).strength).toBe(4);
  // 文字種4つ(74種類)：8文字(約50ビット)は「普通」、12文字(約75ビット)は「強い」、17文字(約106ビット)は「とても強い」
  const all = { useUppercase: true, useLowercase: true, useNumbers: true, useSymbols: true };
  expect((await gen({ length: 8, ...all })).strength).toBe(2);
  expect((await gen({ length: 12, ...all })).strength).toBe(3);
  expect((await gen({ length: 17, ...all })).strength).toBe(4);
  // 直接指定でも同じ基準
  expect((await gen({ length: 10, customChars: "ab" })).strength).toBe(0);
  expect(estimatePasswordStrength(28, 2)).toBe(1);
  expect(estimatePasswordStrength(12, 1)).toBe(0);
});
