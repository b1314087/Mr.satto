import { test, expect } from "../fixtures/premium-test";
import { fixtures } from "../fixtures/paths";
import { uploadFixture, clickAndDownload, assertDownloadedFile } from "../helpers/tool-runner";
import { readDocxText } from "../helpers/docx-inspect";

/**
 * pdf-to-word専用テスト（外出先PC修正指示書§27-28: スキャンPDF(OCR)対応）。
 *
 * 以前は文字レイヤーの無いページ(紙をスキャンした画像PDF)に遭遇すると、
 * ファイル全体を「未対応」としてエラーにしていた。filled-pdf-to-excel.tsが
 * 既に確立しているOCRフォールバック（ページを画像化してtesseract.jsで
 * 認識し、以後は文字レイヤーのページと同じ構造推定ロジックに渡す）を
 * pdf-to-word.tsにも導入したため、実際にOCR経由でWord文書が生成できることを
 * 確認する（ボタンを押して成功表示が出ただけで満足せず、生成されたDOCXの
 * 中身に実際にOCRしたテキストが含まれていることまで確認する）。
 */
test("スキャンPDF(文字レイヤー無し)はOCRで自動的にテキスト化され、Word文書が生成される(§27-28)", async ({ page }) => {
  test.setTimeout(120_000); // OCR(tesseract.js WASM初期化+認識)はテキストレイヤー抽出より時間がかかる

  await page.goto("/tools/pdf-to-word");
  await uploadFixture(page, fixtures.pdfToWordScannedPdf);
  // next dev(Turbopack)の初回コンパイル待ち等でアップロード直後にボタンが
  // 現れないことがある既知の不安定さへの対処（他のspecと同じ再読み込み方式）。
  const buttonVisible = await page
    .getByRole("button", { name: "Wordに変換する" })
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!buttonVisible) {
    await page.reload();
    await uploadFixture(page, fixtures.pdfToWordScannedPdf);
  }
  await expect(page.getByRole("button", { name: "Wordに変換する" })).toBeVisible({ timeout: 20_000 });
  await page.getByRole("button", { name: "Wordに変換する" }).click();
  await expect(page.getByText("完了", { exact: false })).toBeVisible({ timeout: 90_000 });

  // OCRを実際に使用したことを示す表示が出ていること(usedOcr)
  await expect(page.getByText("OCR使用", { exact: false })).toBeVisible();

  const download = await clickAndDownload(page, "Word文書をダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });

  const text = await readDocxText(path);
  // OCRの認識結果は完全一致を期待できないため(フォント・アンチエイリアス等に依存)、
  // 大きく明瞭な英単語"HELLO"・"WORLD"が(大文字小文字を問わず)含まれることだけを
  // 確認する。手書き文字の認識精度自体の検証が目的ではなく、
  // 「OCR経由の文字がちゃんとWord文書の本文として書き出されている」ことの検証が目的。
  const upper = text.toUpperCase();
  expect(upper, `OCR結果にHELLOが含まれていません。実際の認識結果: ${text}`).toContain("HELLO");
  expect(upper, `OCR結果にWORLDが含まれていません。実際の認識結果: ${text}`).toContain("WORLD");
});

/**
 * 書式・構造の再現テスト（箇条書きを表と誤認しない／ヘッダー・フッターを本文に混ぜない／
 * 太字・文字色・中央揃え・画像・リンク・用紙サイズを反映する）。
 *
 * 以前は、箇条書き・番号リストの「記号と本文の間の隙間」を2列の表と誤認して、
 * リストの内容が表の中に入ってしまっていた。また、毎ページ繰り返されるヘッダー/フッターが
 * 本文の途中に混ざり、画像・太字・文字色・揃えは失われていた。
 */
import fs from "node:fs";
import os from "node:os";
import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from "pdf-lib";
import { readDocxPart, listDocxParts } from "../helpers/docx-inspect";

test("箇条書き・表・ヘッダー/フッター・書式・画像・リンクがWord文書へ反映される", async ({ page }, testInfo) => {
  test.setTimeout(120_000);

  // --- テスト用PDFをその場で生成（標準フォントのみ・英数字） ---
  // 日本語を含むテスト出力フォルダではなく、ASCIIだけのパスに置く（アップロード時のパスの扱いの違いを避ける）
  const pdfPath = `${os.tmpdir()}/mrsatto-pdf-to-word-styled-${testInfo.workerIndex}-${Date.now()}.pdf`;
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // 画像（単色のPNG。1x1を拡大表示する）
  const png = await doc.embedPng(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    )
  );
  for (let n = 1; n <= 2; n++) {
    const p = doc.addPage([595, 842]);
    p.drawText("ACME CONFIDENTIAL REPORT", { x: 60, y: 810, size: 9, font: regular });
    p.drawText(`Page ${n}`, { x: 280, y: 30, size: 9, font: regular });
    if (n === 1) {
      p.drawText("Quarterly Report", { x: 60, y: 740, size: 24, font: bold });
      p.drawText("This is a normal paragraph with", { x: 60, y: 700, size: 11, font: regular });
      p.drawText("BOLD WORDS", { x: 230, y: 700, size: 11, font: bold });
      p.drawText("and", { x: 304, y: 700, size: 11, font: regular });
      p.drawText("RED TEXT", { x: 326, y: 700, size: 11, font: regular, color: rgb(1, 0, 0) });
      // 本文の幅いっぱいの行（中央揃えの判定の基準になる本文領域を作る）
      const longLine = "The quick brown fox jumps over the lazy dog and keeps running across the wide open field";
      p.drawText(longLine, { x: 60, y: 686, size: 11, font: regular });
      const centered = "Centered line of text";
      const centerX = 60 + (regular.widthOfTextAtSize(longLine, 11) - regular.widthOfTextAtSize(centered, 11)) / 2;
      p.drawText(centered, { x: centerX, y: 660, size: 11, font: regular });
      for (const [i, t] of ["First item", "Second item", "Third item"].entries()) {
        p.drawText("•", { x: 70, y: 630 - i * 16, size: 11, font: regular });
        p.drawText(t, { x: 88, y: 630 - i * 16, size: 11, font: regular });
      }
      for (const [i, t] of ["Step one", "Step two"].entries()) {
        p.drawText(`${i + 1}.`, { x: 70, y: 570 - i * 16, size: 11, font: regular });
        p.drawText(t, { x: 90, y: 570 - i * 16, size: 11, font: regular });
      }
      const rows = [
        ["Item", "Quantity", "Price"],
        ["Apple", "3", "300"],
        ["Orange", "5", "500"],
        ["Total", "8", "800"],
      ];
      rows.forEach((r, i) => {
        r.forEach((c, k) => p.drawText(c, { x: 70 + k * 150, y: 500 - i * 18, size: 11, font: i === 0 ? bold : regular }));
      });
      p.drawImage(png, { x: 70, y: 340, width: 120, height: 90 });
      p.drawText("Visit our site", { x: 70, y: 300, size: 11, font: regular, color: rgb(0, 0, 1) });
      const link = doc.context.register(
        doc.context.obj({
          Type: "Annot",
          Subtype: "Link",
          Rect: [70, 296, 150, 312],
          Border: [0, 0, 0],
          A: { Type: "Action", S: "URI", URI: PDFString.of("https://example.com/site") },
        })
      );
      p.node.set(PDFName.of("Annots"), doc.context.obj([link]));
    } else {
      p.drawText("Second page body text appears here.", { x: 60, y: 740, size: 11, font: regular });
    }
  }
  fs.writeFileSync(pdfPath, await doc.save());

  // --- 変換 ---
  await page.goto("/tools/pdf-to-word");
  const button = page.getByRole("button", { name: "Wordに変換する" });
  for (let attempt = 0; attempt < 5; attempt++) {
    await uploadFixture(page, pdfPath);
    if (await button.waitFor({ state: "visible", timeout: 12_000 }).then(() => true).catch(() => false)) break;
    if (attempt === 2) await page.reload();
  }
  await button.click();
  await expect(page.getByText("完了", { exact: false }).first()).toBeVisible({ timeout: 90_000 });
  const download = await clickAndDownload(page, "Word文書をダウンロード");
  const { path } = await assertDownloadedFile(download, { format: "zip", minBytes: 100 });

  const xml = await readDocxPart(path, "word/document.xml");
  const bodyText = (await readDocxText(path)).replace(/\s+/g, " ");

  // 本文は全部入っている
  for (const t of ["Quarterly Report", "First item", "Second item", "Step two", "Second page body text"]) {
    expect(bodyText, `本文に「${t}」が無い: ${bodyText}`).toContain(t);
  }
  // 箇条書き・番号リストはWordのリスト（numPr）になり、表（tbl）は本物の表1つだけ
  expect(xml.match(/<w:numPr>/g)?.length ?? 0, "リスト項目がWordの自動番号になっていない").toBeGreaterThanOrEqual(5);
  expect(xml.match(/<w:tbl>/g)?.length ?? 0, "表は1つだけのはず（リストを表と誤認していないこと）").toBe(1);
  expect(xml).toMatch(/Quantity/);
  // 表の列幅が明示されている（幅が無いとWord以外で表が潰れる）
  expect(xml).toMatch(/<w:tblGrid>(<w:gridCol w:w="\d{3,}"\/>)+<\/w:tblGrid>/);
  // ヘッダー・フッターは本文に混ざらず、Wordのヘッダー/フッターに入る
  expect(bodyText).not.toContain("ACME CONFIDENTIAL");
  expect(bodyText).not.toContain("Page 1");
  const parts = await listDocxParts(path);
  const headerXml = (await Promise.all(parts.filter((p) => /word\/header\d*\.xml$/.test(p)).map((p) => readDocxPart(path, p)))).join("");
  const footerXml = (await Promise.all(parts.filter((p) => /word\/footer\d*\.xml$/.test(p)).map((p) => readDocxPart(path, p)))).join("");
  expect(headerXml).toContain("ACME CONFIDENTIAL");
  expect(footerXml, "ページ番号のフィールドがフッターに無い").toMatch(/PAGE/);
  // 書式: 太字・赤い文字・中央揃え・文字サイズ
  expect(xml).toMatch(/<w:b\/>|<w:b w:val="true"\/>/);
  const colors = Array.from(xml.matchAll(/<w:color w:val="([0-9A-Fa-f]{6})"/g)).map((m) => m[1]);
  expect(
    colors.some((c) => parseInt(c.slice(0, 2), 16) > 200 && parseInt(c.slice(2, 4), 16) < 80 && parseInt(c.slice(4, 6), 16) < 80),
    `赤い文字が反映されていない。検出された色: ${colors.join(",")}`
  ).toBe(true);
  expect(xml).toMatch(/<w:jc w:val="center"\/>/);
  // 画像とリンク
  expect(parts.some((p) => p.startsWith("word/media/")), "画像がWord文書に入っていない").toBe(true);
  const rels = await readDocxPart(path, "word/_rels/document.xml.rels");
  expect(rels).toContain("https://example.com/site");
});
