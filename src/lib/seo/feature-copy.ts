import { featureFlags } from "@/lib/config/features";
import type { ToolSeoContent } from "@/lib/seo/tool-content";
import type { CategorySeoContent } from "@/lib/seo/category-content";

/**
 * 機能スイッチ（src/lib/config/features.ts）に合わせて、ツール・カテゴリの説明文
 * （ページの見出し下の文章・FAQ・検索結果に出る説明文）から、
 * 料金プランや広告に触れた文言を取り除く／書き換える。
 *
 * tool-content.ts / category-content.ts には「プレミアムプラン専用」「Freeプランでは広告が出ます」
 * といった、課金・広告がある前提の文言が入っている。課金や広告をやめている間は、
 * それがそのまま表示されると実際と食い違うため、ここで一括して差し替える。
 *
 * - billing オフ: 料金プランの存在を前提とした文言をすべて、プランに触れない文言へ。
 * - billing オン・ads オフ: 広告に触れた文言だけを取り除く。
 * - どちらもオン: 元の文言をそのまま使う（何も変えない）。
 *
 * 元の文章（tool-content.ts / category-content.ts）は書き換えない。課金・広告を再開して
 * スイッチを true に戻せば、元の文言に戻る。
 */

/** 文の差し替えルール。from を含む箇所を、条件に合う to で置き換える。"" は削除。 */
interface TextRule {
  from: string;
  /** 課金オフのときの置き換え。undefined なら何もしない */
  billingOff?: string;
  /** 課金オン・広告オフのときの置き換え。undefined なら何もしない */
  adsOff?: string;
}

const FREE_OK = "はい。会員登録なしで、無料でご利用いただけます。";

// 上から順に適用する。長い文を先に置くこと（短い文が長い文の一部になっているため）。
const TEXT_RULES: TextRule[] = [
  // ---- ツール個別（tool-content.ts）----
  {
    from: "このツールはプレミアムプラン専用の機能です。Standardプランや広告視聴による無料利用の対象には含まれません。",
    billingOff: FREE_OK,
    adsOff: "このツールはプレミアムプラン専用の機能です。Standardプランの対象には含まれません。",
  },
  { from: "このツールはプレミアムプラン専用の機能です。", billingOff: FREE_OK },
  { from: "プレミアムプランで利用できます。", billingOff: "会員登録なしで、無料で利用できます。" },
  {
    from: "はい。Freeプランでは広告の表示が入りますが、そのままご利用いただけます。Standardプラン以上では広告なしで使えます。",
    billingOff: FREE_OK,
    adsOff: "はい。Freeプランでも、そのままご利用いただけます。",
  },
  {
    from: "無料プランは広告視聴で1ページずつ、Standardは広告なしで1ページずつ（ともに利用回数の上限なし）、Premiumはページ数・回数とも無制限です。",
    billingOff: "1回に処理できるのは1ページまでで、利用回数の上限はありません。",
    adsOff: "無料プラン・Standardは1ページずつ（ともに利用回数の上限なし）、Premiumはページ数・回数とも無制限です。",
  },
  {
    from: "無料プランの場合は広告を視聴して利用権を取得します（Standard・Premiumプランでは不要です）。",
    billingOff: "",
    adsOff: "",
  },
  {
    from: "ただし1回に処理できるページ数はプランによって異なります（次の質問をご覧ください）。例えばPremiumプランで1ページ2人分のテンプレートを10ページのPDFへ適用すると、最大20人分をまとめて出力できます。",
    billingOff: "ただし1回に処理できるページ数には上限があります（次の質問をご覧ください）。",
  },
  {
    from: "自動抽出・テンプレートのどちらのモードも、無料プラン・Standardプランは1回あたり1ページまでです（複数ファイルを選んだ場合も合計1ページまでです）。Premiumプランはページ数の制限がありません。",
    billingOff:
      "自動抽出・テンプレートのどちらのモードも、1回あたり1ページまでです（複数ファイルを選んだ場合も合計1ページまでです）。",
  },
  {
    from: "ログイン不要でご利用いただけます。1ページ処理するごとに広告の視聴が必要です（視聴後、その場で1ページ分を処理できます）。1日あたりの利用回数に上限はありません。",
    adsOff: "ログイン不要でご利用いただけます。1回あたり1ページまでで、1日あたりの利用回数に上限はありません。",
  },
  { from: "ページ数・1日の回数ともに制限はありません。広告も表示されません。", adsOff: "ページ数・1日の回数ともに制限はありません。" },

  // ---- カテゴリ（category-content.ts）----
  { from: "OCRなど一部の高度な機能はプレミアムプラン専用です。", billingOff: "" },
  { from: "PDFの表をExcelに変換する機能はプレミアムプラン専用です。", billingOff: "" },
  {
    from: "PDF→Word変換はプレミアムプラン専用、Word段落整理・番号振り直しは無料でご利用いただけます。",
    billingOff: "PDF→Word変換も、Word段落整理・番号振り直しも、会員登録なしで無料でご利用いただけます。",
  },
  { from: "動画ツールはプレミアムプラン専用です。", billingOff: "動画ツールも、会員登録なしで無料でご利用いただけます。" },
  {
    from: "Freeプランでは広告が表示され、Standardプラン以上では広告なしで使えます。",
    billingOff: "会員登録なしで、無料でご利用いただけます。",
    adsOff: "Freeプランでも、そのままご利用いただけます。",
  },
  {
    from: "見積書・請求書・注文書の作成はプレミアムプラン専用、それ以外の大半のツールは無料でご利用いただけます。",
    billingOff: "見積書・請求書・注文書の作成を含め、会員登録なしで無料でご利用いただけます。",
  },
  { from: "無料・プレミアムツールの一覧です。", billingOff: "無料ツールの一覧です。" },
];

/** 課金オフのとき、まるごと取り除くFAQの質問 */
const FAQ_QUESTIONS_REMOVED_WHEN_BILLING_OFF = new Set([
  "無料プランではどのように使えますか？",
  "Standardプランではどのように使えますか？",
  "Premiumプランの制限は？",
]);

/** 課金オフのとき、質問文を書き換える */
const FAQ_QUESTION_REWRITES_WHEN_BILLING_OFF: Record<string, string> = {
  "無料プランでも使えますか？": "無料で使えますか？",
};

/** どちらかのスイッチがオフで、文言の調整が必要か */
function needsAdjustment(): boolean {
  return !featureFlags.billing || !featureFlags.ads;
}

export function adaptText(text: string): string {
  if (!needsAdjustment()) return text;
  let result = text;
  for (const rule of TEXT_RULES) {
    if (!result.includes(rule.from)) continue;
    const to = !featureFlags.billing ? rule.billingOff : rule.adsOff;
    if (to === undefined) continue;
    result = result.split(rule.from).join(to);
  }
  return result;
}

export function adaptToolSeoContent(content: ToolSeoContent): ToolSeoContent {
  if (!needsAdjustment()) return content;
  const billingOff = !featureFlags.billing;
  return {
    ...content,
    metaTitle: adaptText(content.metaTitle),
    metaDescription: adaptText(content.metaDescription),
    lead: adaptText(content.lead),
    howTo: content.howTo.map(adaptText).filter((step) => step.trim() !== ""),
    faq: content.faq
      .filter((item) => !(billingOff && FAQ_QUESTIONS_REMOVED_WHEN_BILLING_OFF.has(item.question)))
      .map((item) => ({
        question: billingOff
          ? (FAQ_QUESTION_REWRITES_WHEN_BILLING_OFF[item.question] ?? adaptText(item.question))
          : adaptText(item.question),
        answer: adaptText(item.answer),
      }))
      .filter((item) => item.answer.trim() !== ""),
  };
}

export function adaptCategorySeoContent(content: CategorySeoContent): CategorySeoContent {
  if (!needsAdjustment()) return content;
  const adapted: CategorySeoContent = { ...content };
  for (const key of Object.keys(adapted) as (keyof CategorySeoContent)[]) {
    const value = adapted[key];
    if (typeof value === "string") {
      (adapted as unknown as Record<string, unknown>)[key] = adaptText(value).replace(/\s+$/, "");
    }
  }
  return adapted;
}
