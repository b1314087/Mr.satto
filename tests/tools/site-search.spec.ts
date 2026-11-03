import { test, expect } from "@playwright/test";
import { searchTools } from "@/lib/tools/search";
import { getListedTools } from "@/lib/tools/data";

/**
 * サイト内検索の改善（表記ゆれ・言い換え・作業目的からの検索）。
 * 前半は検索の仕組みそのもの（ブラウザを使わない確認）、後半はツール一覧ページでの表示を確かめる。
 */

const listed = () => getListedTools().filter((t) => t.status === "available");
const ids = (q: string) => searchTools(listed(), q).map((t) => t.id);
const top = (q: string) => ids(q)[0];

test.describe("検索の仕組み: 表記ゆれ", () => {
  test("「エクセル」「えくせる」「EXCEL」「ｴｸｾﾙ」で、Excel関連のツールが出る（「excel」と同じ結果）", () => {
    const base = ids("excel");
    expect(base.length).toBeGreaterThan(5);
    for (const q of ["エクセル", "えくせる", "EXCEL", "Excel", "ｴｸｾﾙ", "ｅｘｃｅｌ"]) {
      expect(ids(q), q).toEqual(base);
    }
    expect(base).toContain("excel-csv-convert");
    expect(base).toContain("pdf-to-excel");
  });

  test("「ワード」「わーど」で、Word関連のツールが出る。パスワードのツールは出ない", () => {
    for (const q of ["ワード", "わーど", "word", "WORD"]) {
      const r = ids(q);
      expect(r, q).toContain("word-to-pdf");
      expect(r, q).toContain("pdf-to-word");
      expect(r, q).not.toContain("password-generator");
      expect(r, q).not.toContain("pdf-password-protect");
    }
  });

  test("「パスワード」は、これまでどおりパスワードのツールが出る（「ワード」の置き換えの影響を受けない）", () => {
    const r = ids("パスワード");
    expect(r).toContain("password-generator");
    expect(r).toContain("pdf-password-protect");
    expect(r).not.toContain("word-to-pdf");
  });

  test("「パワポ」「パワーポイント」で PowerPoint のツールが出る", () => {
    expect(top("パワポ")).toBe("pptx-invert");
    expect(top("パワーポイント")).toBe("pptx-invert");
  });

  test("全角・半角、大文字・小文字の違いを吸収する（ＰＤＦ / pdf / PDF、Ｈ．２６４ / h264）", () => {
    expect(ids("ＰＤＦ")).toEqual(ids("pdf"));
    expect(ids("PDF")).toEqual(ids("pdf"));
    expect(top("Ｈ．２６４")).toBe("video-h264");
    expect(top("H.264")).toBe("video-h264");
    expect(top("h264")).toBe("video-h264");
  });

  test("「白黒」「モノクロ」「グレースケール」で画像のモノクロ化ツールが最上位になる", () => {
    for (const q of ["白黒", "モノクロ", "グレースケール", "白黒にする"]) {
      expect(top(q), q).toBe("image-grayscale");
    }
  });
});

test.describe("検索の仕組み: 作業目的からの検索", () => {
  const cases: [string, string][] = [
    ["PDFをExcelに", "pdf-to-excel"],
    ["PDFをExcelにしたい", "pdf-to-excel"],
    ["pdf excel", "pdf-to-excel"],
    ["PDFをWordにしたい", "pdf-to-word"],
    ["ExcelをPDFに", "excel-to-pdf"],
    // PDF結合・PDF回転は「PDF編集」に統合済み（一覧・検索には PDF編集 として出る）
    ["PDFを結合", "pdf-edit"],
    ["PDFをまとめたい", "pdf-edit"],
    ["PDFの向きを直したい", "pdf-edit"],
    ["PDFの文字を取り出したい", "pdf-to-text"],
    ["画像を軽くしたい", "image-compress"],
    ["画像の大きさを変えたい", "image-resize"],
    ["画像を白黒に", "image-grayscale"],
    ["画像を白黒にしたい", "image-grayscale"],
    ["動画を軽くする", "video-compress"],
    ["動画を軽くしたい", "video-compress"],
    ["動画の形式を変えたい", "video-convert"],
    ["mp4 h264", "video-h264"],
    ["MP4をH.264にしたい", "video-h264"],
    ["Excelの日付をまとめて変更したい", "excel-date-shift"],
    ["Wordで丸数字を入力したい", "word-renumber"],
    ["写真を切り抜きたい", "image-crop"],
  ];
  for (const [q, expected] of cases) {
    test(`「${q}」→ 最上位は ${expected}`, () => {
      expect(top(q)).toBe(expected);
    });
  }

  test("「PDFの文字を取り出したい」では OCR も出る", () => {
    expect(ids("PDFの文字を取り出したい")).toContain("ocr");
  });

  test("「容量を減らす」で、画像・動画・PDFの圧縮ツールが出る", () => {
    const r = ids("容量を減らす");
    for (const id of ["image-compress", "video-compress", "pdf-compress"]) expect(r).toContain(id);
  });

  test("検索結果に出るのは、一覧に載っている実在のツールだけ", () => {
    const listedIds = new Set(listed().map((t) => t.id));
    for (const [q] of cases) {
      for (const id of ids(q)) expect(listedIds.has(id), `${q} → ${id}`).toBe(true);
    }
  });
});

test.describe("検索の仕組み: 関連性", () => {
  test("正式なツール名で検索すると、そのツールが最上位になる", () => {
    for (const t of listed()) {
      expect(top(t.name), t.name).toBe(t.id);
    }
  });

  test("「PDFをExcelに」で、PDFとExcelが説明文に出てくるだけのツールは出ない", () => {
    const r = ids("PDFをExcelに");
    expect(r.slice(0, 2)).toEqual(["pdf-to-excel", "filled-pdf-to-excel"]);
    expect(r).not.toContain("roster-template");
    expect(r).not.toContain("envelope-address");
    expect(r.length).toBeLessThanOrEqual(4);
  });

  test("「画像を軽くしたい」「動画を軽くする」で、ほかの種類の圧縮ツールは出ない", () => {
    expect(ids("画像を軽くしたい")).toEqual(["image-compress"]);
    expect(ids("動画を軽くする")).toEqual(["video-compress"]);
  });

  test("1語だけの検索（例:「PDF」）は、その言葉を含むツールを従来どおりすべて出す", () => {
    const r = ids("PDF");
    for (const id of ["ocr", "image-to-pdf", "word-to-pdf", "pdf-to-excel"]) expect(r).toContain(id);
  });

  test("従来の空白区切りの検索（「画像 圧縮」「PDF 結合」「QR」）が同じように使える", () => {
    expect(top("画像 圧縮")).toBe("image-compress");
    expect(top("PDF 結合")).toBe("pdf-edit");
    const qr = ids("QR");
    for (const id of ["qr-generator", "business-card-qr"]) expect(qr).toContain(id);
  });

  test("当てはまるツールがない言葉では、結果が0件になる。空の検索ではすべてのツールが出る", () => {
    expect(ids("存在しないもの")).toEqual([]);
    expect(ids("xyzxyz")).toEqual([]);
    expect(ids("")).toHaveLength(listed().length);
    expect(ids("   ")).toHaveLength(listed().length);
  });
});

test.describe("ツール一覧ページでの検索", () => {
  test("PC: 「PDFをExcelに」と入力すると、PDF→Excel が最初のカードになり、正しいページへ移動できる", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/tools");
    const input = page.locator("main").getByRole("searchbox", { name: "ツールを検索" });
    await expect(async () => {
      await input.fill("PDFをExcelに");
      await expect(page).toHaveURL(/q=/, { timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const cards = page.locator("main a[aria-label][href^='/tools/']");
    await expect(cards.first()).toHaveAttribute("href", "/tools/pdf-to-excel");
    await expect(page.locator("main").getByText(`${ids("PDFをExcelに").length}件のツール`)).toBeVisible();
    await cards.first().click();
    await expect(page).toHaveURL(/\/tools\/pdf-to-excel$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("PDF→Excel");
  });

  test("スマホ幅: /tools?q=えくせる を開くと、Excel関連のツールが出る", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`/tools?q=${encodeURIComponent("えくせる")}`);
    const n = ids("えくせる").length;
    await expect(page.locator("main").getByText(`${n}件のツール`)).toBeVisible();
    await expect(page.locator("main a[aria-label][href='/tools/excel-csv-convert']")).toBeVisible();
    // 横にはみ出さない
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("当てはまるツールがないときは「該当するツールが見つかりませんでした」と出る", async ({ page }) => {
    await page.goto(`/tools?q=${encodeURIComponent("存在しないもの")}`);
    await expect(page.locator("main").getByText("0件のツール")).toBeVisible();
    await expect(page.locator("main").getByText("該当するツールが見つかりませんでした")).toBeVisible();
  });

  test("ヘッダーの検索欄から「動画を軽くする」で検索すると、動画圧縮が出る", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/about");
    const input = page.locator("header.ms-bar").getByRole("searchbox", { name: "ツールを検索" });
    await input.fill("動画を軽くする");
    await input.press("Enter");
    await expect(page).toHaveURL(/\/tools\?q=/);
    await expect(page.locator("main a[aria-label][href='/tools/video-compress']")).toBeVisible();
    await expect(page.locator("main").getByText("1件のツール")).toBeVisible();
  });
});
