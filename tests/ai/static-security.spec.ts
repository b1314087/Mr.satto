import { test, expect } from "@playwright/test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** 静的な検査: APIキーや特権の接続が、ブラウザ側のコードに入り込んでいないこと */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const SRC = join(process.cwd(), "src");
const files = walk(SRC);
const read = (p: string) => readFileSync(p, "utf8");

test.describe("AI機能の静的な安全確認", () => {
  test("OPENAI_API_KEY を参照するのは、サーバー側の接続ファイルだけ", () => {
    const hits = files.filter((f) => read(f).includes("OPENAI_API_KEY")).map((f) => f.replace(SRC, "src"));
    expect(hits.sort()).toEqual(["src/lib/ai/server.ts"]);
  });

  test("NEXT_PUBLIC_ を付けたOpenAI関連の変数が無い", () => {
    for (const f of files) expect(read(f), f).not.toMatch(/NEXT_PUBLIC_[A-Z_]*OPENAI/);
  });

  test("クライアントコンポーネント（\"use client\"）が、サーバー専用のAIモジュールを読み込まない", () => {
    const forbidden = ["@/lib/ai/server", "@/lib/ai/openai-client", "@/lib/ai/service", "@/lib/ai/ledger", "@/lib/supabase/service"];
    for (const f of files) {
      const text = read(f);
      if (!/^\s*["']use client["']/.test(text)) continue;
      for (const m of forbidden) expect(text, `${f} が ${m} を読み込んでいる`).not.toContain(m);
    }
  });

  test("サーバー側の接続ファイルは server-only を付けている", () => {
    expect(read(join(SRC, "lib/ai/server.ts"))).toContain('import "server-only"');
  });

  test("OpenAIのAPIを呼ぶコードは openai-client.ts だけ", () => {
    const hits = files.filter((f) => read(f).includes("api.openai.com")).map((f) => f.replace(SRC, "src"));
    expect(hits).toEqual(["src/lib/ai/openai-client.ts"]);
  });

  test("AI関連のモジュールが、本文をDB・ファイル・localStorageに書かない（書き込み系の呼び出しが無い）", () => {
    const aiFiles = files.filter((f) => f.includes("/lib/ai/") || f.includes("/api/ai/"));
    for (const f of aiFiles) {
      const text = read(f);
      expect(text, f).not.toMatch(/localStorage|sessionStorage|writeFile|appendFile|indexedDB/);
      expect(text, f).not.toMatch(/\.from\(["'`]\w+["'`]\)\s*\.(insert|upsert|update)/);
    }
  });
});
