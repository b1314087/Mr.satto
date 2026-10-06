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
      const bits = length * Math.log2(custom.length);
      const strength = bits >= 100 ? 4 : bits >= 70 ? 3 : bits >= 45 ? 2 : bits >= 28 ? 1 : 0;
      return { password: chars.join(""), strength };
    }

    const pools = (Object.keys(CHAR_SETS) as (keyof typeof CHAR_SETS)[]).filter(
      (key) => input[key]
    );

    if (pools.length === 0) {
      throw new Error("使用する文字の種類を1つ以上選ぶか、使う文字を指定してください");
    }

    const allChars = pools.map((key) => CHAR_SETS[key]).join("");
    const passwordChars = Array.from({ length }, () => allChars[randomInt(allChars.length)]);

    // 選択した全ての文字種が最低1文字は含まれるようにする(置き換える位置は重ならないよう並べ替えてから決める)
    const positions = Array.from({ length }, (_, i) => i);
    for (let i = positions.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    pools.forEach((key, i) => {
      if (i < positions.length) {
        const set = CHAR_SETS[key];
        passwordChars[positions[i]] = set[randomInt(set.length)];
      }
    });
    const password = passwordChars.join("");

    let strength = 0;
    if (length >= 8) strength++;
    if (length >= 12) strength++;
    if (pools.length >= 3) strength++;
    if (pools.length === 4) strength++;

    return { password, strength };
  }
}
