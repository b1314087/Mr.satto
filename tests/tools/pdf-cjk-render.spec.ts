import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest } from "@playwright/test";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { test, expect } from "../fixtures/premium-test";
import { clickAndDownload, waitForFileInputHydrated, waitForSuccess } from "../helpers/tool-runner";

/**
 * PDFに入っていない日本語のフォント（名前だけで指定した文字）を、画像にしても消さずに描く。
 * pdf.js は、日本語の文字の対応表（CMap）が無いと、このような文字を描けない。
 * src/lib/pdf/pdfjs-client.ts の PDFJS_ASSET_OPTIONS（public/pdfjs/ のCMap・標準フォント）を、PDFを開くすべての所で渡す。
 */

/** 日本語の文字を、フォントを入れずに（HeiseiKakuGo-W5・UniJIS-UCS2-H で名前だけ指定して）書いたPDF */
async function nonEmbeddedJapanesePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const ctx = doc.context;
  const descriptor = ctx.register(
    ctx.obj({ Type: "FontDescriptor", FontName: "HeiseiKakuGo-W5", Flags: 4, FontBBox: [-92, -250, 1010, 922], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 })
  );
  const cidFont = ctx.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "HeiseiKakuGo-W5", FontDescriptor: descriptor });
  cidFont.set(PDFName.of("CIDSystemInfo"), ctx.obj({ Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Japan1"), Supplement: 2 }));
  const font = ctx.register(
    ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "HeiseiKakuGo-W5-UniJIS-UCS2-H", Encoding: "UniJIS-UCS2-H", DescendantFonts: [ctx.register(cidFont)] })
  );
  page.node.setFontDictionary(PDFName.of("FJ"), font);
  let hex = "";
  for (const ch of "日本語の文字テスト　山田太郎") hex += ch.codePointAt(0)!.toString(16).padStart(4, "0");
  page.node.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(`BT /FJ 36 Tf 50 700 Td <${hex}> Tj ET`)));
  return Buffer.from(await doc.save());
}

plainTest("PDFを開くすべての所で、日本語の文字の対応表（CMap）と標準フォントの場所を渡す。その置き場所に、ファイルがある", () => {
  const roots = ["src"];
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  roots.forEach(walk);
  const calls: string[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (/getDocument\(\{/.test(line)) calls.push(`${f}: ${line.trim()}`);
    }
  }
  expect(calls.length).toBeGreaterThan(5);
  for (const c of calls) expect(c, c).toContain("PDFJS_ASSET_OPTIONS");
  expect(fs.existsSync("public/pdfjs/cmaps/UniJIS-UCS2-H.bcmap")).toBe(true);
  expect(fs.existsSync("public/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap")).toBe(true);
  expect(fs.existsSync("public/pdfjs/standard_fonts/LiberationSans-Regular.ttf")).toBe(true);
  // pdfjs-dist と同じ版のファイル（版を上げたときに、置き換え忘れを見つける）
  for (const name of ["UniJIS-UCS2-H.bcmap", "Adobe-Japan1-UCS2.bcmap"]) {
    expect(fs.readFileSync(`public/pdfjs/cmaps/${name}`).equals(fs.readFileSync(`node_modules/pdfjs-dist/cmaps/${name}`))).toBe(true);
  }
});

test("PDF→画像：PDFに入っていない日本語のフォントの文字も、消えずに画像に描かれる", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pdf-cjk-"));
  try {
    const src = path.join(dir, "日本語.pdf");
    fs.writeFileSync(src, await nonEmbeddedJapanesePdf());
    await page.goto("/tools/pdf-to-image");
    await waitForFileInputHydrated(page);
    await page.locator('input[type="file"]').first().setInputFiles(src);
    await page.getByRole("button", { name: "画像化する" }).click();
    await waitForSuccess(page, "完了");
    const download = await clickAndDownload(page, /ダウンロード/);
    const out = path.join(dir, "out.jpg");
    await download.saveAs(out);

    // 文字のある帯（上から約14%の位置）に、黒い画素が十分にある（文字が描かれている）
    const dark = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const bmp = await createImageBitmap(new Blob([arr], { type: "image/jpeg" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const band = ctx.getImageData(0, Math.floor(bmp.height * 0.1), bmp.width, Math.floor(bmp.height * 0.1)).data;
      let n = 0;
      for (let i = 0; i < band.length; i += 4) if (band[i] + band[i + 1] + band[i + 2] < 384) n++;
      return n;
    }, fs.readFileSync(out).toString("base64"));
    expect(dark).toBeGreaterThan(3000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
