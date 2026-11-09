import { BrowserProcessor } from "../types";

export interface PasswordGenerateInput {
  length: number;
  useUppercase: boolean;
  useLowercase: boolean;
  useNumbers: boolean;
  useSymbols: boolean;
  /**
   * 使う文字を直接指定する(例: "abc123")。空白以外の文字が1つでもあれば、チェックボックスの文字種は無視し、
   * ここに書いた文字だけでパスワードを作る(同じ文字を重ねて書いたときは1文字として数える)。
   */
  customChars?: string;
}

export interface PasswordGenerateOutput {
  password: string;
  /** 簡易的な強度スコア (0-4) */
  strength: number;
}

const CHAR_SETS = {
  useUppercase: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  useLowercase: "abcdefghijkmnpqrstuvwxyz",
  useNumbers: "23456789",
  useSymbols: "!@#$%^&*()-_=+[]{}",
};

/** 指定文字を重複なく取り出す(空白・改行は除く。絵文字などもArray.fromで1文字として扱う) */
export function uniqueChars(text: string): string[] {
  return Array.from(new Set(Array.from(text).filter((ch) => !/\s/.test(ch))));
}

/**
 * パスワードの強度(0〜4)。使える文字の種類の数 poolSize と長さから、総当たりで試す組み合わせの数(ビット数
 * = 長さ × log2(文字の種類の数))を出して決める。文字種をいくつ選んだかではなく、実際の組み合わせの数で判断する
 * (たとえば、4文字なら文字種を4つ選んでも弱く、数字だけでも十分に長ければ強い)。
 * 目安：28ビット未満=とても弱い、28〜=弱い、45〜=普通、70〜=強い、100〜=とても強い
 */
export function estimatePasswordStrength(length: number, poolSize: number): number {
  if (poolSize < 2 || length <= 0) return 0;
  const bits = length * Math.log2(poolSize);
  return bits >= 100 ? 4 : bits >= 70 ? 3 : bits >= 45 ? 2 : bits >= 28 ? 1 : 0;
}

/** 0以上max未満の乱数。偏りが出ないよう、範囲外の値は引き直す */
function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do {
    crypto.getRandomValues(buf);
  } while (buf[0] >= limit);
  return buf[0] % max;
}

export class PasswordGenerateProcessor extends BrowserProcessor<
  PasswordGenerateInput,
  PasswordGenerateOutput
> {
  async process(input: PasswordGenerateInput) {
    const { length } = input;
    if (length < 4 || length > 128) {
      throw new Error("パスワードの長さは4〜128文字で指定してください");
    }

    const custom = uniqueChars(input.customChars ?? "");
    if (custom.length === 1) {
      throw new Error("使う文字は2種類以上指定してください");
    }
    if (custom.length >= 2) {
      const chars = Array.from({ length }, () => custom[randomInt(custom.length)]);
      // 指定した文字の種類が少ないほど推測されやすいため、総当たりの組み合わせ数(ビット数)から強度を出す
      return { password: chars.join(""), strength: estimatePasswordStrength(length, custom.length) };
    }

    const pools = (Object.keys(CHAR_SETS) as (keyof typeof CHAR_SETS)[]).filter(
      (key) => input[key]
    );

    if (pools.length === 0) {
      throw new Error("使用する文字の種類を1つ以上選ぶか、使う文字を指定してください");
    }

    const allChars = pools.map((key) => CHAR_SETS[key]).join("");
    // 選んだ全ての文字種が最低1文字は含まれるようにする。足りない文字種の文字を後から差し込むと、その文字種の文字が
    // 出やすくなる(1文字ごとの確率が偏る)ため、全体を一様に作り直す(棄却法)。こうすると「選んだ文字種がすべて入る
    // パスワード」の中から、どれも同じ確率で選ばれる。いちばん厳しい4文字・文字種4つでも、平均20回ほどで決まる
    let password = "";
    for (let attempt = 0; ; attempt++) {
      if (attempt >= 100_000) throw new Error("パスワードを生成できませんでした。もう一度お試しください");
      password = Array.from({ length }, () => allChars[randomInt(allChars.length)]).join("");
      if (pools.every((key) => Array.from(password).some((ch) => CHAR_SETS[key].includes(ch)))) break;
    }

    // 強度は、文字種の数ではなく、使える文字の種類の数と長さ(組み合わせの数)から出す(文字を直接指定したときと同じ基準)
    return { password, strength: estimatePasswordStrength(length, allChars.length) };
  }
}
