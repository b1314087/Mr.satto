import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";

/**
 * サーバー関数（Vercel Function）への sharp の同梱を除外する設定の「守り」のテスト。
 *
 * 背景: Next.js は画像最適化用の sharp（と @img/* の本体ファイル）を、ほぼすべての画面の
 * サーバー関数に同梱する（1画面あたり約48MB）。このアプリは next/image を使っておらず、
 * 画像最適化はVercel側のサービスが担当するため、next.config.ts の outputFileTracingExcludes で
 * 同梱から除外している（Function Storage の使用量を減らす目的）。
 *
 * このテストが守ること:
 *  1. 除外の設定が、sharp 関連（node_modules/sharp と node_modules/@img）だけを対象にしている
 *     （フォント・OCR・背景除去・PDFなどのファイルを巻き込んで除外していない）。
 *  2. アプリのコードが next/image や sharp を使い始めていない。使い始めたら、このテストが失敗して
 *     「sharp の除外設定を見直す」よう知らせる（除外したまま next/image を使うと、画像最適化が動かなくなるため）。
 *  3. sharp を直接の依存関係として追加していない（追加するなら、除外の是非を先に判断する）。
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, acc);
    else if (/\.(ts|tsx|mjs|js|jsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** コメントを除いたコード部分だけを返す（コメント中の「next/image は不要」という説明に反応しないため） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

test.describe("サーバー関数への sharp 同梱の除外", () => {
  test("next.config.ts: outputFileTracingExcludes が sharp 関連だけを除外している", () => {
    const src = read("next.config.ts");
    const block = src.match(/outputFileTracingExcludes:\s*\{([\s\S]*?)\n\s{2}\},/);
    expect(block, "outputFileTracingExcludes の設定が見つからない").toBeTruthy();
    const entries = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    // キー（"/*"）と、除外パターンだけが並ぶ
    expect(entries).toEqual(["/*", "./node_modules/sharp/**/*", "./node_modules/@img/**/*"]);
    // 日本語フォント・OCR・背景除去・PDF関連を、除外の対象にしていない
    for (const word of ["fonts", "tesseract", "ort", "models", "pdf", "public"]) {
      expect(block![1].replace(/\/\*[\s\S]*?\*\//g, ""), word).not.toContain(word);
    }
    // 依存パッケージそのものは、serverExternalPackages 以外で操作していない
    expect(src).toContain('serverExternalPackages: ["stripe"]');
  });

  test("アプリのコードが next/image・sharp を使っていない（使い始めたら除外設定を見直す）", () => {
    const offenders: string[] = [];
    for (const file of [...listSourceFiles(path.join(ROOT, "src")), ...listSourceFiles(path.join(ROOT, "scripts"))]) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (/from\s+["']next\/image["']|require\(\s*["']next\/image["']\s*\)|import\(\s*["']next\/image["']\s*\)/.test(code)) {
        offenders.push(`${path.relative(ROOT, file)}: next/image`);
      }
      if (/from\s+["']sharp["']|require\(\s*["']sharp["']\s*\)|import\(\s*["']sharp["']\s*\)/.test(code)) {
        offenders.push(`${path.relative(ROOT, file)}: sharp`);
      }
    }
    expect(
      offenders,
      "next/image または sharp を使うコードが追加された。next.config.ts の outputFileTracingExcludes（sharp除外）を見直すこと"
    ).toEqual([]);
  });

  test("next.config.ts に画像最適化の設定（images）がない（設定を足すなら、除外の是非を先に判断する）", () => {
    const code = stripComments(read("next.config.ts"));
    expect(code).not.toMatch(/\bimages\s*:/);
  });

  test("package.json: sharp を直接の依存関係にしていない（Next.js の任意の依存として入っているだけ）", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(pkg.dependencies ?? {}).not.toHaveProperty("sharp");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("sharp");
  });

  test("OG画像・アイコンは next/og の ImageResponse で作っている（sharp を直接呼ばない）", () => {
    for (const f of ["src/app/opengraph-image.tsx", "src/app/icon.tsx", "src/app/apple-icon.tsx", "src/app/tools/[tool]/opengraph-image.tsx"]) {
      const code = stripComments(read(f));
      expect(code, f).toContain("next/og");
      expect(code, f).not.toMatch(/\bsharp\b/);
    }
  });
});

test.describe("背景除去(onnxruntime-web)のWASMを、ビルドで二重に出力しない設定", () => {
  const ALIAS_KEY = "onnxruntime-web/wasm";
  const ALIAS_TARGET = "./node_modules/onnxruntime-web/dist/ort.wasm.min.mjs";
  const md5 = (rel: string) => crypto.createHash("md5").update(fs.readFileSync(path.join(ROOT, rel))).digest("hex");

  test("next.config.ts: turbopack.resolveAlias が、外部WASM版(ort.wasm.min.mjs)だけを指している", () => {
    const code = stripComments(read("next.config.ts"));
    const block = code.match(/turbopack:\s*\{\s*resolveAlias:\s*\{([\s\S]*?)\}\s*,?\s*\}/);
    expect(block, "turbopack.resolveAlias の設定が見つからない").toBeTruthy();
    const entries = [...block![1].matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(entries).toEqual([[ALIAS_KEY, ALIAS_TARGET]]);
    expect(fs.existsSync(path.join(ROOT, ALIAS_TARGET)), "alias の参照先が存在しない").toBe(true);
  });

  test("onnxruntime-web: 公式の外部WASM条件が、alias の参照先と同じファイルを指している（更新時の検知）", () => {
    const pkg = JSON.parse(read("node_modules/onnxruntime-web/package.json")) as {
      exports: Record<string, { import?: Record<string, string> }>;
    };
    const extern = pkg.exports["./wasm"]?.import?.["onnxruntime-web-use-extern-wasm"];
    expect(extern, "公式の外部WASM条件が見つからない（onnxruntime-web の構成が変わった）").toBeTruthy();
    expect(path.posix.normalize(`node_modules/onnxruntime-web/${extern}`)).toBe(path.posix.normalize(ALIAS_TARGET));
  });

  test("public/ort/ の実行ファイルが、インストール済み onnxruntime-web の dist と完全に一致している", () => {
    for (const f of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
      expect(md5(`public/ort/${f}`), `${f} が onnxruntime-web の版と一致しない。更新したら public/ort/ も差し替えること`).toBe(
        md5(`node_modules/onnxruntime-web/dist/${f}`)
      );
    }
  });

  test("背景除去は onnxruntime-web/wasm を読み込み、wasmPaths で /ort/ を指定している", () => {
    const code = stripComments(read("src/lib/processors/browser/background-remove.ts"));
    expect(code).toContain('import("onnxruntime-web/wasm")');
    expect(code).toContain('ORT_BASE_URL = "/ort/"');
    expect(code).toContain("ort-wasm-simd-threaded.mjs");
    expect(code).toContain("ort-wasm-simd-threaded.wasm");
  });
});
