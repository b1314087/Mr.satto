import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { adaptToolSeoContentWith, adaptCategorySeoContentWith, type CopyContext } from "@/lib/seo/feature-copy";
import { toolSeoContent, getToolSeoContent } from "@/lib/seo/tool-content";
import { categorySeoContent, getCategorySeoContent } from "@/lib/seo/category-content";
import { buildFaqPage } from "@/lib/seo/structured-data";
import { categories, getCategoryToolsLabel, getRelatedToolsHeading } from "@/lib/tools/categories";
import { tools } from "@/lib/tools/data";
import { hasImplementation } from "@/lib/tools/registry";
import { getRelatedTools } from "@/lib/tools/related-tools";
import { OCR_MAX_PAGES, PDF_TO_EXCEL_MAX_OCR_PAGES, PDF_TO_EXCEL_MAX_PAGES, PDF_TO_WORD_MAX_PAGES } from "@/lib/pdf/page-limits";

/**
 * 工程11: 残りのSEO改善（ページ数上限の説明・title・表記統一・内部リンク・年度カレンダーのdescription・
 * 記入済みPDF→ExcelのAI表現）の回帰テスト。
 */

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const PRODUCTION: CopyContext = { billing: true, ads: false, premiumOnly: false, standardOffered: false };

test.describe("L1: PDFツールのページ数上限の説明", () => {
  test("上限の値は、実際の制限処理が使う定数と同じ（定数は一か所だけで定義）", () => {
    // 確認済みの現在値。値を変えたときは、このテストと説明文が一緒に更新されるのを確認すること。
    expect([PDF_TO_WORD_MAX_PAGES, PDF_TO_EXCEL_MAX_PAGES, PDF_TO_EXCEL_MAX_OCR_PAGES, OCR_MAX_PAGES]).toEqual([50, 50, 20, 20]);

    // 実際に制限をかける処理が、同じ定数を参照している（手書きの数字が別にない）
    const word = read("src/lib/processors/browser/pdf-to-word.ts");
    const excel = read("src/lib/processors/browser/pdf-to-excel.ts");
    const ocr = read("src/lib/processors/browser/ocr.ts");
    expect(word).toContain('from "@/lib/pdf/page-limits"');
    expect(word).toMatch(/const MAX_PDF_TO_WORD_PAGES = PDF_TO_WORD_MAX_PAGES;/);
    expect(word).toMatch(/pdf\.numPages > MAX_PDF_TO_WORD_PAGES/);
    expect(excel).toContain('from "@/lib/pdf/page-limits"');
    expect(excel).toMatch(/const MAX_PDF_TO_EXCEL_PAGES = PDF_TO_EXCEL_MAX_PAGES;/);
    expect(excel).toMatch(/const MAX_OCR_PAGES = PDF_TO_EXCEL_MAX_OCR_PAGES;/);
    expect(excel).toMatch(/pdf\.numPages > MAX_PDF_TO_EXCEL_PAGES/);
    expect(excel).toMatch(/ocrConfidences\.length >= MAX_OCR_PAGES/);
    expect(ocr).toContain('from "@/lib/pdf/page-limits"');
    expect(ocr).toMatch(/const MAX_OCR_PAGES = OCR_MAX_PAGES;/);
    expect(ocr).toMatch(/pdf\.numPages > MAX_OCR_PAGES/);
  });

  test("PDF→Word・PDF→Excel・OCR: 操作説明とFAQに、実際の上限が書かれている", () => {
    const word = toolSeoContent["pdf-to-word"];
    expect(word.howTo[0]).toContain(`${PDF_TO_WORD_MAX_PAGES}ページまで`);
    expect(word.faq.find((f) => f.question === "PDFのページ数に制限はありますか？")?.answer).toContain(`${PDF_TO_WORD_MAX_PAGES}ページまで`);

    const excel = toolSeoContent["pdf-to-excel"];
    expect(excel.howTo[0]).toContain(`${PDF_TO_EXCEL_MAX_PAGES}ページまで`);
    const excelAnswer = excel.faq.find((f) => f.question === "PDFのページ数に制限はありますか？")?.answer ?? "";
    expect(excelAnswer).toContain(`${PDF_TO_EXCEL_MAX_PAGES}ページまで`);
    expect(excelAnswer).toContain(`${PDF_TO_EXCEL_MAX_OCR_PAGES}ページまで`);
    // 既存のスキャン画像のFAQの数字も、同じ定数から作られている
    expect(excel.faq.find((f) => f.question.startsWith("スキャンした画像"))?.answer).toContain(`最大${PDF_TO_EXCEL_MAX_OCR_PAGES}ページ`);

    const ocr = toolSeoContent["ocr"];
    expect(ocr.howTo[0]).toContain(`PDFは${OCR_MAX_PAGES}ページまで`);
    const ocrAnswer = ocr.faq.find((f) => f.question === "PDFのページ数に制限はありますか？")?.answer ?? "";
    expect(ocrAnswer).toContain(`${OCR_MAX_PAGES}ページまで`);
    expect(ocrAnswer).not.toContain("あまりにページ数の多い");
  });

  test("本番相当の表示（FAQ・FAQPage構造化データ）でも、上限の説明が残る。ファイルサイズ上限とは別に書かれている", () => {
    for (const id of ["pdf-to-word", "pdf-to-excel", "ocr"]) {
      const adapted = adaptToolSeoContentWith(toolSeoContent[id], PRODUCTION);
      const json = JSON.stringify(buildFaqPage(adapted.faq));
      expect(json, id).toContain("ページまで");
      expect(adapted.howTo[0], id).toContain("上限50MB");
    }
    // 現在の設定で実際に出る説明（getToolSeoContent）でも同じ
    expect(getToolSeoContent("pdf-to-word")?.faq.map((f) => f.question)).toContain("PDFのページ数に制限はありますか？");
  });

  test("説明文（description）には制限を詰め込まない", () => {
    for (const id of ["pdf-to-word", "pdf-to-excel", "ocr"]) {
      expect(toolSeoContent[id].metaDescription, id).not.toMatch(/ページまで|\d+ページ/);
    }
  });
});

test.describe("L2・L3: title・名称の整合", () => {
  test("PDF記入・注釈のtitleは、画面上のツール名で始まり、PDF編集と区別できる", () => {
    const tool = tools.find((t) => t.id === "pdf-fill-annotate")!;
    expect(tool.name).toBe("PDF記入・注釈");
    const title = toolSeoContent["pdf-fill-annotate"].metaTitle;
    expect(title.startsWith("PDF記入・注釈｜")).toBe(true);
    expect(title.startsWith("PDF編集")).toBe(false);
    expect(toolSeoContent["pdf-edit"].metaTitle.startsWith("PDF編集｜")).toBe(true);
    // 説明文も、記入・注釈の機能を説明している
    expect(toolSeoContent["pdf-fill-annotate"].metaDescription).toMatch(/書き込み|入力/);
  });

  test("SNSサイズ変換: 画面上の名称とtitleが一致する", () => {
    const tool = tools.find((t) => t.id === "image-sns-size")!;
    expect(tool.name).toBe("SNSサイズ変換");
    expect(toolSeoContent["image-sns-size"].metaTitle.startsWith("SNSサイズ変換｜")).toBe(true);
  });

  test("全ツール: titleに、画面上のツール名（「の」「を」の違いと、末尾の補足の括弧は除く）が含まれる", () => {
    const normalize = (v: string) => v.replace(/[のを]/g, "");
    const problems: string[] = [];
    for (const tool of tools) {
      const seo = toolSeoContent[tool.id];
      if (!seo) continue;
      const core = tool.name.split("（")[0];
      if (!normalize(seo.metaTitle).includes(normalize(core))) problems.push(`${tool.id}: 「${tool.name}」/「${seo.metaTitle}」`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("全カテゴリ: titleは、見出し（カテゴリ名＋ツール一覧）で始まる（その他ツール一覧・生成ツール一覧を含む）", () => {
    const problems: string[] = [];
    for (const c of categories) {
      const title = categorySeoContent[c.id].metaTitle;
      if (!title.startsWith(`${getCategoryToolsLabel(c)}一覧｜`)) problems.push(`${c.id}: ${title}`);
    }
    expect(problems, problems.join("\n")).toEqual([]);
    expect(categorySeoContent.other.metaTitle.startsWith("その他ツール一覧｜")).toBe(true);
  });

  test("関連ツールの見出しは、「その他」でも不自然に重ならない", () => {
    expect(getRelatedToolsHeading({ name: "PDF" })).toBe("PDFの他のツール");
    expect(getRelatedToolsHeading({ name: "生成ツール" })).toBe("生成ツールの他のツール");
    expect(getRelatedToolsHeading({ name: "その他" })).toBe("その他カテゴリの他のツール");
  });
});

test.describe("L5: プラン名の表記（無料／プレミアム／スタンダード）", () => {
  test("元のSEO文（tool-content・category-content）に、英語表記のプラン名が残っていない", () => {
    const problems: string[] = [];
    const texts = (c: { metaTitle: string; metaDescription: string; lead?: string; intro?: string; howTo?: string[]; faq?: { question: string; answer: string }[] }) => [
      c.metaTitle, c.metaDescription, c.lead ?? "", c.intro ?? "", ...(c.howTo ?? []), ...(c.faq ?? []).flatMap((f) => [f.question, f.answer]),
    ];
    for (const [id, c] of Object.entries(toolSeoContent)) for (const t of texts(c)) if (/Free|Premium|Standard/.test(t)) problems.push(`${id}: ${t.slice(0, 60)}`);
    for (const [id, c] of Object.entries(categorySeoContent)) for (const t of texts(c)) if (/Free|Premium|Standard/.test(t)) problems.push(`${id}: ${t.slice(0, 60)}`);
    expect(problems, problems.join("\n")).toEqual([]);
  });

  test("プランID・内部の識別子は変わっていない（表示名だけを日本語にした）", () => {
    const types = read("src/lib/plans/types.ts");
    expect(types).toContain('export type Plan = "free" | "standard" | "premium";');
    expect(types).toContain('export const OFFERED_PLAN_IDS = ["free", "premium"]');
  });

  test("記入済みPDF→Excelの画面メッセージも、「ご利用中のプラン」「プレミアムプラン」の日本語表記になっている", () => {
    // コメント（開発者向けの説明）は除き、画面に出る文言だけを見る
    const gate = read("src/components/tools/implementations/filled-pdf-to-excel/usage-gate.tsx")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(gate).not.toMatch(/Free・Standard|Premiumプラン|Standardプラン/);
    expect(gate).toContain("プレミアムプランをご利用ください");
  });
});

test.describe("L4: pptx-invertへの内部リンク", () => {
  const available = tools.filter((t) => t.status === "available" && hasImplementation(t.id));

  test("他のツールページの関連ツールに、pptx-invertが出る（使う場面が近いOffice書類のツールから）", () => {
    const from = available.filter((t) => getRelatedTools(t).related.some((r) => r.id === "pptx-invert")).map((t) => t.id);
    expect(from.sort()).toEqual(["excel-to-pdf", "word-to-pdf"]);
  });

  test("pptx-invertのページには、同じくOffice書類を扱うツールが関連ツールとして出る", () => {
    const tool = tools.find((t) => t.id === "pptx-invert")!;
    const { related, sameCategoryCandidateCount } = getRelatedTools(tool);
    expect(related.slice(0, 2).map((t) => t.id)).toEqual(["word-to-pdf", "excel-to-pdf"]);
    // 他カテゴリのツールが混ざるので、「○○の他のツール」ではなく「こちらのツールもおすすめです」の見出しになる
    expect(related.length).toBeGreaterThan(sameCategoryCandidateCount);
  });

  test("relatedToolIds は少数に限られ、存在する利用可能なツールだけを指している（無関係なリンクを増やさない）", () => {
    const withPins = tools.filter((t) => t.relatedToolIds && t.relatedToolIds.length > 0);
    // 工程11: Office文書系（word-to-pdf / excel-to-pdf / pptx-invert）、工程12: PDF修正への導線（pdf-edit / 記入・注釈 / ページ番号 / 透かし / pdf-fix）
    expect(withPins.map((t) => t.id).sort()).toEqual([
      "excel-to-pdf",
      "pdf-add-page-numbers",
      "pdf-edit",
      "pdf-fill-annotate",
      "pdf-fix",
      "pdf-watermark",
      "pptx-invert",
      "word-to-pdf",
    ]);
    for (const t of withPins) {
      expect(t.relatedToolIds!.length, t.id).toBeLessThanOrEqual(2);
      for (const id of t.relatedToolIds!) {
        const target = tools.find((x) => x.id === id);
        expect(target, `${t.id} -> ${id}`).toBeTruthy();
        expect(target!.status === "available" && hasImplementation(id), `${t.id} -> ${id}`).toBe(true);
      }
    }
  });

  test("関連ツールの重複がなく、件数も従来どおり（最大4件）。同カテゴリのツールがすべて外れることはない", () => {
    for (const t of available) {
      const { related } = getRelatedTools(t);
      expect(related.length, t.id).toBeLessThanOrEqual(4);
      expect(new Set(related.map((r) => r.id)).size, t.id).toBe(related.length);
      expect(related.map((r) => r.id), t.id).not.toContain(t.id);
    }
    const pdfTool = tools.find((t) => t.id === "word-to-pdf")!;
    const rel = getRelatedTools(pdfTool).related;
    expect(rel.filter((r) => r.category === "pdf").length).toBeGreaterThanOrEqual(3);
  });

  test("ツールページ: pptx-invertのカードへのリンクが実際に表示され、リンク先が開く", async ({ page }) => {
    for (const from of ["word-to-pdf", "excel-to-pdf"]) {
      await page.goto(`/tools/${from}`);
      const link = page.locator('main a[href="/tools/pptx-invert"]').first();
      await expect(link, from).toBeVisible();
      await expect(page.locator("main h2", { hasText: "こちらのツールもおすすめです" }), from).toBeVisible();
    }
    await page.goto("/tools/pptx-invert");
    await expect(page.locator("h1")).toHaveText("PowerPoint白黒反転");
    await expect(page.locator('main a[href="/tools/word-to-pdf"]').first()).toBeVisible();
  });
});

test.describe("L6: 年度カレンダーのdescription", () => {
  const ctx: CopyContext = PRODUCTION;
  const desc = () => adaptToolSeoContentWith(toolSeoContent["fiscal-calendar"], ctx).metaDescription;

  test("簡潔で（140字以内）、機能・出力形式・対応ファイルが伝わる", () => {
    const d = desc();
    expect(d.length).toBeLessThanOrEqual(140);
    expect(d).toContain("祝日入りカレンダー");
    expect(d).toContain("Excel（月別12シート）");
    expect(d).toContain("PDF（月別12ページ）");
    expect(d).toContain("予定表（Excel・CSV・PDF・画像）");
  });

  test("通常の処理（ブラウザ内）と、AI利用時の外部送信（同意のうえ）を区別している", () => {
    const d = desc();
    expect(d).toContain("通常はブラウザ内で処理し");
    expect(d).toContain("AIで読み取る場合（プレミアム）のみ、同意のうえ外部のAIサービスへ送信します");
    // 「すべて送信されない」と言い切っていない
    expect(d).not.toMatch(/サーバーへ送信されません/);
  });

  test("課金オフでは、AI・画像・プレミアムに触れない", () => {
    const d = adaptToolSeoContentWith(toolSeoContent["fiscal-calendar"], { billing: false, ads: false, premiumOnly: false, standardOffered: false }).metaDescription;
    expect(d).not.toMatch(/AI|画像|プレミアム|外部/);
    expect(d).toContain("予定表（Excel・CSV・PDF）");
    expect(d).toContain("ブラウザ内で処理するので、サーバーへ送信されません");
  });

  test("FAQ・手順の詳しい説明（同意・外部送信の条件）は残っている", () => {
    const seo = getToolSeoContent("fiscal-calendar")!;
    const faqText = seo.faq.map((f) => f.answer).join("\n");
    expect(faqText).toContain("同意したときだけ");
    expect(faqText).toContain("外部のAIサービス");
    expect(seo.howTo.join("\n")).toContain("同意したときだけ");
  });
});

test.describe("記入済みPDF→Excel: AIを使わないという説明", () => {
  test("実装がAIの機能（OpenAI・AI補助・AIのAPI）を使っていないことを確認する（説明の前提）", () => {
    const dirs = ["src/components/tools/implementations/filled-pdf-to-excel", "src/lib/tools/filled-pdf-to-excel", "src/lib/pdf-template"];
    const files = [
      "src/components/tools/implementations/filled-pdf-to-excel-tool.tsx",
      "src/components/tools/implementations/filled-pdf-to-excel-template-panel.tsx",
      "src/lib/processors/browser/filled-pdf-to-excel.ts",
    ];
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
    for (const f of [...dirs.flatMap(walk), ...files]) {
      const src = read(f);
      expect(src, f).not.toMatch(/from "@\/lib\/ai|api\/ai|openai|calendar-assist|fiscal-calendar-(ai|image)-assist/i);
    }
  });

  test("FAQと画面の説明は、「AIによる読み取り補助や外部のAIサービスは使わない」と明確に書き、他のAI機能まで否定しない", () => {
    const seo = getToolSeoContent("filled-pdf-to-excel")!;
    const faq = seo.faq.find((f) => f.question.startsWith("手書き文字"))!;
    expect(faq.answer).toContain("AIによる読み取り補助や外部のAIサービスを使いません");
    expect(faq.answer).toContain("ブラウザの中で");
    expect(faq.answer).not.toContain("LLM");
    // サイト全体で「AIを使わない」と言い切っていない（年度カレンダーのAI読み取りがあるため、このツールに限った説明）
    expect(faq.answer).not.toMatch(/Mr\.Satto(では|は)AIを使いません/);
    const ui = read("src/components/tools/implementations/filled-pdf-to-excel-tool.tsx");
    expect(ui).toContain("このツールでは、AIによる読み取り補助や外部のAIサービスは使いません。");
    expect(ui).not.toContain("AIによる曖昧な判断は行っていません");
  });

  test("工程10の修正（スタンダード非提供・1ページ制限）が維持されている", () => {
    const seo = getToolSeoContent("filled-pdf-to-excel")!;
    const text = [seo.metaDescription, ...seo.faq.flatMap((f) => [f.question, f.answer])].join("\n");
    expect(text).not.toMatch(/Standard|スタンダード/);
    expect(text).toContain("1回あたり1ページまで");
  });
});

test.describe("工程10の回帰（カテゴリの説明は現在の設定から取得できる）", () => {
  test("getCategorySeoContent / getToolSeoContent は、全カテゴリ・全ツールで値を返す", () => {
    for (const c of categories) expect(getCategorySeoContent(c.id).metaTitle, c.id).toBeTruthy();
    for (const id of Object.keys(toolSeoContent)) expect(getToolSeoContent(id)?.metaDescription, id).toBeTruthy();
    expect(adaptCategorySeoContentWith(categorySeoContent.video, PRODUCTION).intro).not.toContain("プレミアムプラン専用");
  });
});
