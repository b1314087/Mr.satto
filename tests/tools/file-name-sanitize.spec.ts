import { test, expect } from "@playwright/test";
import { MAX_FILE_NAME_BYTES, dedupeFileNames, getExtension, replaceExtension, sanitizeFileName, stripExtension } from "@/lib/utils/format";
import { createZip } from "@/lib/utils/zip";
import { unzipSync } from "fflate";

/**
 * ファイル名の無害化（工程39）の単体テスト。ブラウザ・ファイルシステムは使わない。
 */
const bytes = (s: string) => new TextEncoder().encode(s).length;

test.describe("通常のファイル名は変わらない", () => {
  test("日本語・英数字・空白・括弧・記号つきのファイル名と、拡張子", () => {
    for (const name of ["請求書_2026年10月.pdf", "report-final.xlsx", "my photo (1).png", "見積書・注文書_2026-10-28.pdf", "a.tar.gz", "ファイル 名.csv", "データ＿全角（カッコ）.xlsx", "emoji😀.png"]) {
      expect(sanitizeFileName(name), name).toBe(name);
    }
  });

  test("既存の関数の動き: 拡張子の分離・差し替え・重複の解消", () => {
    expect(stripExtension("photo.jpg")).toBe("photo");
    expect(getExtension("photo.jpg")).toBe("jpg");
    expect(getExtension("noext")).toBe("");
    expect(replaceExtension("scan.pdf", "png")).toBe("scan.png");
    expect(dedupeFileNames(["a.jpg", "a.jpg", "a_2.jpg"])).toEqual(["a.jpg", "a_2.jpg", "a_2_2.jpg"]);
  });
});

test.describe("危険な名前を無害にする", () => {
  test("パス区切り・パス要素（../）は、区切りが残らない（上位のフォルダへ出られない）", () => {
    for (const name of ["../../etc/passwd", "..\\..\\windows\\system32", "a/b/c.txt", "/abs/path.pdf", "C:\\x\\y.pdf", "..", ".", "...", "/", "\\"]) {
      const out = sanitizeFileName(name);
      expect(out, name).not.toMatch(/[\\/]/);
      expect(out, name).not.toMatch(/^\.+$/);
      expect(out.startsWith("."), name).toBe(false);
    }
    expect(sanitizeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(sanitizeFileName("..")).toBe("file");
  });

  test("Windowsで使えない文字は _ に置き換える", () => {
    expect(sanitizeFileName('a:b*c?d"e<f>g|h.txt')).toBe("a_b_c_d_e_f_g_h.txt");
  });

  test("制御文字・NUL・DEL・C1制御文字・行区切りは取り除く", () => {
    expect(sanitizeFileName("a\u0000b\u0001c\u001fd\u007fe\u0085f\u2028g\u2029h.pdf")).toBe("abcdefgh.pdf");
    expect(sanitizeFileName("line1\nline2\r\n.txt")).toBe("line1line2.txt");
  });

  test("拡張子を偽装する左右方向の制御文字・ゼロ幅文字・BOMは取り除く", () => {
    // 見た目は「invoice_fdp.exe」→ 実際は .exe を隠す、右から左への上書き（U+202E）を使った偽装
    const spoof = "invoice_\u202Efdp.exe";
    expect(sanitizeFileName(spoof)).toBe("invoice_fdp.exe");
    expect(sanitizeFileName("a\u200Bb\u200Cc\u200Dd\uFEFFe\u2066f\u2069g.pdf")).toBe("abcdefg.pdf");
  });

  test("壊れたサロゲート（対になっていない文字）は取り除き、正しい絵文字は残す", () => {
    expect(sanitizeFileName("a\ud800b\udc00c😀.png")).toBe("abc😀.png");
  });

  test("先頭のピリオド・空白（隠しファイル化）と、末尾のピリオド・空白は取り除く", () => {
    expect(sanitizeFileName(".htaccess")).toBe("htaccess");
    expect(sanitizeFileName("  spaced.pdf  ")).toBe("spaced.pdf");
    expect(sanitizeFileName("name. . .")).toBe("name");
    expect(sanitizeFileName("　全角空白.pdf　")).toBe("全角空白.pdf");
  });

  test("Windowsの予約名は、拡張子の有無・大文字小文字を問わず、先頭に _ を付ける", () => {
    for (const name of ["CON", "con.txt", "PRN.pdf", "Aux.tar.gz", "NUL", "COM1", "com9.csv", "LPT1.xlsx", "lpt9"]) {
      expect(sanitizeFileName(name), name).toBe(`_${name}`);
    }
    // 予約名に似ているだけの名前は、そのまま
    for (const name of ["console.txt", "CON1.txt", "COM10.txt", "communication.pdf", "aux-file.pdf"]) {
      expect(sanitizeFileName(name), name).toBe(name);
    }
  });

  test("空・空白だけ・禁止文字だけ・不正な型は、フォールバック 'file' か、無害な名前になる", () => {
    expect(sanitizeFileName("")).toBe("file");
    expect(sanitizeFileName("   ")).toBe("file");
    expect(sanitizeFileName("\u0000\u0001")).toBe("file");
    expect(sanitizeFileName("...")).toBe("file");
    expect(sanitizeFileName(undefined as unknown as string)).toBe("file");
    expect(sanitizeFileName(null as unknown as string)).toBe("file");
    expect(sanitizeFileName(123 as unknown as string)).toBe("123");
  });

  test("禁止文字だけの名前は、_ だけにならずに済む範囲で扱う（空にはならない）", () => {
    expect(sanitizeFileName("???")).toBe("___");
    expect(sanitizeFileName("***.pdf")).toBe("___.pdf");
  });
});

test.describe("長すぎる名前", () => {
  test("拡張子を残して、UTF-8で上限のバイト数に収める（日本語でも文字の途中で切らない）", () => {
    const longAscii = `${"a".repeat(400)}.pdf`;
    const outAscii = sanitizeFileName(longAscii);
    expect(bytes(outAscii)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(outAscii.endsWith(".pdf")).toBe(true);

    const longJa = `${"あ".repeat(300)}.xlsx`;
    const outJa = sanitizeFileName(longJa);
    expect(bytes(outJa)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(outJa.endsWith(".xlsx")).toBe(true);
    expect(outJa).not.toContain("\uFFFD");
    expect(Array.from(outJa).every((c) => c === "あ" || ".xlsx".includes(c))).toBe(true);

    const emoji = sanitizeFileName(`${"😀".repeat(100)}.png`);
    expect(bytes(emoji)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    expect(emoji).not.toContain("\uFFFD");
  });

  test("拡張子が極端に長い（拡張子とは言えない）ときも、全体が上限に収まる", () => {
    const out = sanitizeFileName(`name.${"x".repeat(500)}`);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
  });

  test("上限ちょうどの名前は、そのまま", () => {
    const exact = `${"a".repeat(MAX_FILE_NAME_BYTES - 4)}.pdf`;
    expect(sanitizeFileName(exact)).toBe(exact);
  });
});

test.describe("性質（何度適用しても同じ・結果が常に安全）", () => {
  const nasty = [
    "../../x", "CON", "con.txt", ".hidden", "a\u202Eb.exe", `${"あ".repeat(300)}.pdf`, "  . .  ", "", "a/b\\c", "name.", "\u0000", "😀".repeat(80), "a\ud800", "x".repeat(250), ".pdf", "COM1.", " con ",
  ];

  test("冪等: sanitize(sanitize(x)) == sanitize(x)", () => {
    for (const name of nasty) {
      const once = sanitizeFileName(name);
      expect(sanitizeFileName(once), JSON.stringify(name)).toBe(once);
    }
  });

  test("結果は、空でなく、区切り・制御文字・先頭ピリオド・末尾のピリオド/空白を含まず、上限以内", () => {
    for (const name of nasty) {
      const out = sanitizeFileName(name);
      expect(out.length, JSON.stringify(name)).toBeGreaterThan(0);
      expect(out).not.toMatch(/[\\/:*?"<>|\u0000-\u001f\u007f]/);
      expect(out.startsWith(".")).toBe(false);
      expect(/[.\s]$/.test(out)).toBe(false);
      expect(bytes(out)).toBeLessThanOrEqual(MAX_FILE_NAME_BYTES);
    }
  });
});

test.describe("ZIPの中のファイル名（最後の砦）", () => {
  test("危険な名前は、ZIPの中でも無害な名前になり、重複は番号で区別される。内容は壊れない", async () => {
    const zip = await createZip([
      { name: "../../evil.txt", blob: new Blob(["evil"]) },
      { name: "ok.txt", blob: new Blob(["ok"]) },
      { name: "a/b.txt", blob: new Blob(["ab"]) },
      { name: "a_b.txt", blob: new Blob(["ab2"]) },
      { name: "CON.txt", blob: new Blob(["con"]) },
    ]);
    const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
    const names = Object.keys(files);
    expect(names).toHaveLength(5);
    for (const n of names) expect(n).not.toMatch(/[\\/]|^\.\./);
    expect(names).toContain("_.._evil.txt");
    expect(names).toContain("ok.txt");
    expect(names).toContain("a_b.txt");
    expect(names).toContain("a_b_2.txt");
    expect(names).toContain("_CON.txt");
    expect(new TextDecoder().decode(files["ok.txt"])).toBe("ok");
  });

  test("すでに無害な名前（日本語を含む）は、ZIPの中でも変わらない", async () => {
    const zip = await createZip([{ name: "請求書_1.pdf", blob: new Blob(["x"]) }, { name: "請求書_2.pdf", blob: new Blob(["y"]) }]);
    expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer()))).sort()).toEqual(["請求書_1.pdf", "請求書_2.pdf"]);
  });
});

test.describe("実装の静的確認", () => {
  test("保存（a.download）に、無害化を通している", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/utils/format.ts", "utf8");
    expect(src).toMatch(/a\.download = sanitizeFileName\(filename\)/);
    // 古いSafariで構文エラーになる後読み（lookbehind）を使っていない
    expect(src).not.toMatch(/\(\?<[!=]/);
  });
});
