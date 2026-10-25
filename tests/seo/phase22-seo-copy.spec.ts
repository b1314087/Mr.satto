import { test, expect } from "@playwright/test";
import {
  adaptCategorySeoContentWith,
  adaptToolSeoContentWith,
  type CopyContext,
} from "@/lib/seo/feature-copy";
import { toolSeoContent, type ToolSeoContent } from "@/lib/seo/tool-content";
import { categorySeoContent } from "@/lib/seo/category-content";
import { buildFaqPage, buildOfferDescription } from "@/lib/seo/structured-data";
import { categories, getCategoryToolsLabel } from "@/lib/tools/categories";
import { tools } from "@/lib/tools/data";
import { OFFERED_PLAN_IDS } from "@/lib/plans/types";

/**
 * 工程10: ツール・カテゴリのSEO文（メタディスクリプション・FAQ・FAQPage構造化データ・カテゴリ紹介文）が、
 * 実際の提供状態（課金・広告・プレミアム限定ツールの有無・提供プラン）と食い違わないことの回帰テスト。
 *
 * 文言の差し替えは src/lib/seo/feature-copy.ts が行う。ここでは設定の組み合わせを直接与えて確かめる
 * （開発サーバーは課金・広告ともオンで動くため、本番相当の状態はこのテストで担保する）。
 */

/** 現在の本番相当: 課金オン・広告オフ。プレミアム限定ツールなし・Standardなし */
const PRODUCTION: CopyContext = { billing: true, ads: false, premiumOnly: false, standardOffered: false };

function allText(content: ToolSeoContent): string[] {
  return [content.metaTitle, content.metaDescription, content.lead, ...content.howTo, ...content.faq.flatMap((f) => [f.question, f.answer])];
}

function categoryText(c: { metaTitle: string; metaDescription: string; intro: string }): string[] {
  return [c.metaTitle, c.metaDescription, c.intro];
}

test.describe("SEO文: 本番相当（課金オン・広告オフ・プレミアム限定ツールなし・Standardなし）", () => {
  test("実際の設定と、この回帰テストの前提が一致している（プレミアム限定ツールなし・Standard未提供）", () => {
    // 前提が変わったとき（例: ツールを再び有料にした）は、このテストが先に失敗して気づける。
    expect(tools.filter((t) => t.status === "available" && t.requiredPlan === "premium")).toHaveLength(0);
    expect((OFFERED_PLAN_IDS as readonly string[]).includes("standard")).toBe(false);
  });

  test("全ツールのSEO文に、プレミアム専用・Standard・広告の文言が残らない（FAQPage構造化データも同じ）", () => {
    const FORBIDDEN = /プレミアムプラン専用|プレミアム専用|プレミアムプランで利用できます|Standard|スタンダード|Free|Premium|広告/;
    const problems: string[] = [];
    for (const [id, content] of Object.entries(toolSeoContent)) {
      const adapted = adaptToolSeoContentWith(content, PRODUCTION);
      for (const text of allText(adapted)) if (FORBIDDEN.test(text)) problems.push(`${id}: ${text.slice(0, 80)}`);
      const json = JSON.stringify(buildFaqPage(adapted.faq));
      if (FORBIDDEN.test(json)) problems.push(`${id}: FAQPage構造化データ`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("全カテゴリのメタ情報・紹介文に、プレミアム専用・無料・プレミアムの区別・Standard・広告の文言が残らない", () => {
    const FORBIDDEN = /プレミアムプラン専用|無料・プレミアム|Standard|スタンダード|Free|Premium|広告/;
    const problems: string[] = [];
    for (const [id, content] of Object.entries(categorySeoContent)) {
      const adapted = adaptCategorySeoContentWith(content, PRODUCTION);
      for (const text of categoryText(adapted)) if (FORBIDDEN.test(text)) problems.push(`${id}: ${text.slice(0, 80)}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("工程9で指摘された16ツールのメタディスクリプションとFAQは、無料で使える案内になる", () => {
    const ids = [
      "pdf-to-excel", "pdf-to-word", "word-to-pdf", "excel-to-pdf", "ocr",
      "video-convert", "video-compress", "video-resize", "video-frame-rate", "video-h264", "video-thumbnail", "video-metadata-remove",
      "estimate-generator", "quote-order-generator", "invoice-generator", "order-generator",
    ];
    for (const id of ids) {
      const adapted = adaptToolSeoContentWith(toolSeoContent[id], PRODUCTION);
      expect(adapted.metaDescription, id).toContain("無料で利用できます");
      expect(adapted.metaDescription, id).not.toContain("プレミアム");
      const free = adapted.faq.find((f) => f.question === "無料プランでも使えますか？");
      expect(free?.answer, id).toBe("はい。会員登録なしで、無料でご利用いただけます。");
    }
  });

  test("記入済みPDF→Excel: Standardの記述は消え、ページ数の制限・プレミアムの違いは残る", () => {
    const adapted = adaptToolSeoContentWith(toolSeoContent["filled-pdf-to-excel"], PRODUCTION);
    const text = allText(adapted).join("\n");
    expect(text).not.toMatch(/Standard|スタンダード|Free|Premium|広告/);
    expect(adapted.faq.map((f) => f.question)).not.toContain("スタンダードプランではどのように使えますか？");
    expect(adapted.metaDescription).toContain("無料プランは1回1ページまで");
    expect(adapted.metaDescription).toContain("プレミアムプランはページ数・回数とも無制限");
    const limit = adapted.faq.find((f) => f.question === "1回に処理できるページ数の上限は？");
    expect(limit?.answer).toContain("無料プランは1回あたり1ページまで");
    expect(limit?.answer).toContain("プレミアムプランはページ数の制限がありません");
    expect(adapted.faq.map((f) => f.question)).toContain("プレミアムプランの制限は？");
    expect(adapted.faq.map((f) => f.question)).toContain("無料プランではどのように使えますか？");
    // 他の仕様の説明（保存されない・手書きの注意）は残る
    expect(text).toContain("送信・保存されることはありません");
  });
});

test.describe("SEO文: 設定が変わったときの復活・既存の切り替え", () => {
  test("特定のツールがプレミアム限定になれば、その説明は元の文言のまま復活する（他のツールは無料の案内のまま）", () => {
    const ctx: CopyContext = { ...PRODUCTION, premiumOnly: true };
    const ocr = adaptToolSeoContentWith(toolSeoContent["ocr"], ctx);
    expect(ocr.metaDescription).toContain("プレミアムプランで利用できます。");
    expect(ocr.faq.find((f) => f.question === "無料プランでも使えますか？")?.answer).toBe("このツールはプレミアムプラン専用の機能です。");
    // プレミアム専用の案内に、提供していないStandardは出さない
    const pdfToExcel = adaptToolSeoContentWith(toolSeoContent["pdf-to-excel"], ctx);
    const a = pdfToExcel.faq.find((f) => f.question === "無料プランでも使えますか？")?.answer ?? "";
    expect(a).toContain("プレミアムプラン専用");
    expect(a).not.toContain("Standard");
    // カテゴリも、限定ツールがあるカテゴリでは元の案内が復活する
    const video = adaptCategorySeoContentWith(categorySeoContent["video"], ctx);
    expect(video.intro).toContain("動画ツールはプレミアムプラン専用です。");
    expect(video.metaDescription).toContain("無料・プレミアムツールの一覧です。");
  });

  test("課金・広告・限定ツール・Standardがすべてある元の状態では、文言を一切変えない", () => {
    const all: CopyContext = { billing: true, ads: true, premiumOnly: true, standardOffered: true };
    for (const [id, content] of Object.entries(toolSeoContent)) expect(adaptToolSeoContentWith(content, all), id).toBe(content);
    for (const [id, content] of Object.entries(categorySeoContent)) expect(adaptCategorySeoContentWith(content, all), id).toBe(content);
  });

  test("Standardを再び提供し、広告もオンなら、記入済みPDF→Excelの元の説明がそのまま使える", () => {
    const all: CopyContext = { billing: true, ads: true, premiumOnly: false, standardOffered: true };
    const adapted = adaptToolSeoContentWith(toolSeoContent["filled-pdf-to-excel"], all);
    expect(adapted.faq.map((f) => f.question)).toContain("スタンダードプランではどのように使えますか？");
    expect(adapted.metaDescription).toContain("スタンダードは広告なしで1ページずつ");
  });

  test("広告オン・Standardなし: 広告の説明は残し、提供していないStandardだけをプレミアムに置き換える", () => {
    const ctx: CopyContext = { billing: true, ads: true, premiumOnly: false, standardOffered: false };
    const filled = adaptToolSeoContentWith(toolSeoContent["filled-pdf-to-excel"], ctx);
    const text = allText(filled).join("\n");
    expect(text).not.toMatch(/Standard|スタンダード|Free|Premium/);
    expect(filled.metaDescription).toContain("無料プランは広告視聴で1ページずつ");
    const generic = adaptToolSeoContentWith(toolSeoContent["image-resize"], ctx);
    expect(allText(generic).join("\n")).not.toMatch(/Standard|スタンダード/);
    const cat = adaptCategorySeoContentWith(categorySeoContent["image"], ctx);
    expect(categoryText(cat).join("\n")).not.toMatch(/Standard|スタンダード/);
  });

  test("課金オフ: プランに触れた文言が、全ツール・全カテゴリから消える（AIの読み取りの案内も出ない）", () => {
    const off: CopyContext = { billing: false, ads: false, premiumOnly: false, standardOffered: false };
    const FORBIDDEN = /プレミアム|Premium|Free|Standard|スタンダード|広告|有料/;
    const problems: string[] = [];
    for (const [id, content] of Object.entries(toolSeoContent)) {
      const adapted = adaptToolSeoContentWith(content, off);
      for (const text of allText(adapted)) if (FORBIDDEN.test(text)) problems.push(`${id}: ${text.slice(0, 80)}`);
    }
    for (const [id, content] of Object.entries(categorySeoContent)) {
      for (const text of categoryText(adaptCategorySeoContentWith(content, off))) if (FORBIDDEN.test(text)) problems.push(`${id}: ${text.slice(0, 80)}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
    const fiscal = allText(adaptToolSeoContentWith(toolSeoContent["fiscal-calendar"], off)).join("\n");
    expect(fiscal).not.toMatch(/AI|画像|外部/);
    // 課金オフでも、Excel・CSV・PDFの取り込みの説明は残る
    expect(fiscal).toContain("Excel（.xlsx）・CSV・PDF");
  });
});

test.describe("年度カレンダー: 通常のブラウザ内処理とAI利用時の外部送信の説明", () => {
  const on: CopyContext = PRODUCTION;
  const content = () => adaptToolSeoContentWith(toolSeoContent["fiscal-calendar"], on);

  test("メタディスクリプションは、ブラウザ内処理とAI利用時の外部送信を区別している", () => {
    const d = content().metaDescription;
    expect(d).toContain("通常はブラウザ内で処理し");
    expect(d).toContain("AIで読み取る場合");
    expect(d).toContain("同意のうえ外部のAIサービスへ送信");
    expect(d).not.toContain("ブラウザ内で処理するので、サーバーへ送信されません");
  });

  test("FAQ: 対応形式（Excel・CSV・PDF・画像）と、同意・外部送信の条件が書かれている", () => {
    const faq = content().faq;
    const imp = faq.find((f) => f.question.startsWith("予定表のファイル"));
    expect(imp?.question).toBe("予定表のファイル（Excel・CSV・PDF・画像）を読み込めますか？");
    expect(imp?.answer).toContain("Excel（.xlsx）・CSV・PDF・画像（PNG・JPG）");
    expect(imp?.answer).toContain("同意したときだけ");
    expect(imp?.answer).toContain("外部のAIサービス");
    const upload = faq.find((f) => f.question === "作成したファイルはサーバーに送信されますか？");
    expect(upload?.answer).toContain("通常の作成と、Excel・CSV・文字のPDFの読み込みは");
    expect(upload?.answer).toContain("AIで読み取る補助（プレミアムの機能）を使う場合に限り");
    expect(upload?.answer).toContain("外部のAIサービスへ送信されます");
    // 「すべてブラウザ内で処理され、送信されることはありません」を、AIの場合も含めて言い切らない
    expect(upload?.answer).not.toMatch(/^いいえ/);
  });

  test("操作手順は、画像・スキャンPDFがAIで読まれること、同意したときだけ送ることを案内している", () => {
    const step = content().howTo.find((s) => s.startsWith("予定を入れたいとき"));
    expect(step).toContain("Excel（.xlsx）・CSV・PDF・画像（PNG・JPG）");
    expect(step).toContain("同意したときだけ");
  });

  test("対応形式の記載は、実装が受け付けるファイルの種類と一致している", async () => {
    const { EVENT_FILE_ACCEPT } = await import("@/lib/calendar/event-file");
    const ext = EVENT_FILE_ACCEPT.split(",").filter((s) => s.startsWith("."));
    expect(ext.sort()).toEqual([".csv", ".jpeg", ".jpg", ".pdf", ".png", ".xlsm", ".xlsx"]);
  });

  test("FAQPage構造化データの内容が、画面に出すFAQと一致している", () => {
    const faq = content().faq;
    const ld = buildFaqPage(faq);
    expect(ld.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(faq.map((f) => [f.question, f.answer]));
  });
});

test.describe("トップページの構造化データ（WebApplication）の説明", () => {
  test("本番相当（課金オン・広告オフ・Standardなし）: 提供していないプランや広告回避の案内を出さない", () => {
    const d = buildOfferDescription({ billing: true, ads: false, standardOffered: false });
    expect(d).not.toMatch(/Standard|スタンダード|広告/);
    expect(d).toContain("無料でご利用いただけます");
    expect(d).toContain("プレミアムプラン");
  });

  test("広告オン: 広告視聴の説明は残し、提供していないStandardには触れない／提供すれば触れる", () => {
    expect(buildOfferDescription({ billing: true, ads: true, standardOffered: false })).toBe("広告視聴による1時間の無料利用、またはプレミアムプランへの加入で利用できます。");
    expect(buildOfferDescription({ billing: true, ads: true, standardOffered: true })).toContain("スタンダード／プレミアムプラン");
  });

  test("課金オフ: プランに一切触れない", () => {
    const d = buildOfferDescription({ billing: false, ads: false, standardOffered: false });
    expect(d).not.toMatch(/プラン|プレミアム|Standard|Premium|広告/);
  });
});

test.describe("カテゴリ名の表記（「生成ツールツール」の重複）", () => {
  test("カテゴリ名の末尾に「ツール」がある・ない、どちらの場合も重複しない", () => {
    expect(getCategoryToolsLabel({ name: "生成ツール" })).toBe("生成ツール");
    expect(getCategoryToolsLabel({ name: "画像" })).toBe("画像ツール");
    for (const c of categories) {
      const label = getCategoryToolsLabel(c);
      expect(label, c.id).not.toContain("ツールツール");
      expect(label.endsWith("ツール"), c.id).toBe(true);
      expect(label.startsWith(c.name), c.id).toBe(true);
    }
  });

  test("生成ツールのカテゴリページ: 見出し・パンくず・BreadcrumbListの名前が一致し、重複がない", async ({ page }) => {
    await page.goto("/tools/generator");
    await expect(page.locator("h1")).toHaveText("生成ツール一覧");
    const crumb = page.locator('nav[aria-label="パンくずリスト"], nav[aria-label*="パンくず"]').first();
    await expect(crumb).toContainText("生成ツール");
    await expect(crumb).not.toContainText("ツールツール");
    const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
    const breadcrumb = ld.map((t) => JSON.parse(t)).find((j) => j["@type"] === "BreadcrumbList");
    expect(breadcrumb.itemListElement.map((i: { name: string }) => i.name)).toEqual(["トップ", "生成ツール"]);
    expect(ld.join("")).not.toContain("ツールツール");
  });

  test("生成ツールのツールページ（年度カレンダー）と、他のカテゴリのパンくず・構造化データが正しい", async ({ page }) => {
    for (const [path, label] of [
      ["/tools/fiscal-calendar", "生成ツール"],
      ["/tools/image-resize", "画像ツール"],
      ["/tools/pdf-merge", "PDFツール"],
      ["/tools/csv-to-excel", "Excel・CSVツール"],
      ["/tools/char-count", "その他ツール"],
    ] as const) {
      await page.goto(path);
      const ld = (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t));
      const breadcrumb = ld.find((j) => j["@type"] === "BreadcrumbList");
      expect(breadcrumb.itemListElement[1].name, path).toBe(label);
      await expect(page.locator("main").first(), path).not.toContainText("ツールツール");
    }
  });
});
