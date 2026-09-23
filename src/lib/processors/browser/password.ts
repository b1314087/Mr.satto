import { BrowserProcessor } from "../types";

export interface PasswordGenerateInput {
  length: number;
  useUppercase: boolean;
  useLowercase: boolean;
  useNumbers: boolean;
  useSymbols: boolean;
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

export class PasswordGenerateProcessor extends BrowserProcessor<
  PasswordGenerateInput,
  PasswordGenerateOutput
> {
  async process(input: PasswordGenerateInput) {
    const { length } = input;
    if (length < 4 || length > 128) {
      throw new Error("パスワードの長さは4〜128文字で指定してください");
    }

    const pools = (Object.keys(CHAR_SETS) as (keyof typeof CHAR_SETS)[]).filter(
      (key) => input[key]
    );

    if (pools.length === 0) {
      throw new Error("使用する文字種類を1つ以上選択してください");
    }

    const allChars = pools.map((key) => CHAR_SETS[key]).join("");
    const randomValues = new Uint32Array(length);
    crypto.getRandomValues(randomValues);

    let password = Array.from(randomValues, (v) => allChars[v % allChars.length]).join("");

    // 選択した全ての文字種が最低1文字は含まれるようにする
    const passwordChars = password.split("");
    pools.forEach((key, i) => {
      if (i < passwordChars.length) {
        const set = CHAR_SETS[key];
        const idx = new Uint32Array(1);
        crypto.getRandomValues(idx);
        passwordChars[i] = set[idx[0] % set.length];
      }
    });
    password = passwordChars.sort(() => Math.random() - 0.5).join("");

    let strength = 0;
    if (length >= 8) strength++;
    if (length >= 12) strength++;
    if (pools.length >= 3) strength++;
    if (pools.length === 4) strength++;

    return { password, strength };
  }
}
