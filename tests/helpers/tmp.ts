import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "@playwright/test";

/**
 * テストの一時ファイルの置き場所。
 *
 * テストの中では、そのテストの出力フォルダ(test-results/…。Playwrightが、次にテストを実行するときに
 * まとめて消す)の中に作る。以前は OS の一時フォルダ(/tmp)に作って消していなかったため、テストを
 * 何度も実行すると、変換したPDF・画像が数GB単位で残っていた(ディスクを圧迫し、テストが不安定になる原因)。
 * テストの外(global-setup など)から呼ばれたときだけ、OS の一時フォルダに作る。
 */
export function scratchDir(prefix: string): string {
  try {
    const dir = test.info().outputPath(`${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  }
}
