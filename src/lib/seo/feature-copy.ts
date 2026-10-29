import { featureFlags } from "@/lib/config/features";
import { OFFERED_PLAN_IDS } from "@/lib/plans/types";
import { tools } from "@/lib/tools/data";
import { FISCAL_CALENDAR_COPY_PAIRS } from "@/lib/seo/fiscal-calendar-copy";
import type { ToolSeoContent } from "@/lib/seo/tool-content";
import type { CategorySeoContent } from "@/lib/seo/category-content";

/**
 * 現在の提供状態（機能スイッチ・提供しているプラン・プレミアム限定ツールの有無）に合わせて、
 * ツール・カテゴリの説明文（ページの見出し下の文章・FAQ・検索結果に出る説明文・FAQPage構造化データ）から、
 * 料金プランや広告に触れた文言を取り除く／書き換える。
 *
 * tool-content.ts / category-content.ts には「プレミアムプラン専用」「無料プランでは広告が出ます」
 * 「スタンダードプラン」といった、課金・広告・複数プランがある前提の文言が入っている。
 * 実際の提供状態とずれたままだと、使えるツールを「使えない」と案内してしまうため、ここで一括して差し替える。
 *
 * 差し替えの条件は、次の4つ（すべて現在のコードの設定から読み取る。この中に値を直接書かない）。
 * - billing（機能スイッチ）      : オフなら、料金プランの存在を前提とした文言をすべて、プランに触れない文言へ。
 * - ads（機能スイッチ）          : オフなら、広告に触れた文言を取り除く。
 * - premiumOnly                  : そのツール（カテゴリは所属ツールのいずれか）が、実際にプレミアム限定か。
 *                                  src/lib/tools/data.ts の tools（ALL_TOOLS_STANDARD 適用後）の requiredPlan から求める。
 *                                  限定でなければ「プレミアム専用」の文言は事実と異なるため、無料で使える旨に差し替える。
 * - standardOffered              : スタンダードプランを提供しているか（OFFERED_PLAN_IDS）。
 *                                  提供していなければ、Standardに触れた文言を取り除く／プレミアムに置き換える。
 *
 * すべてが「元の文言どおり」の状態（課金・広告オン、プレミアム限定ツールあり、Standardあり）のときだけ、
 * 元の文言をそのまま使う。元の文章（tool-content.ts / category-content.ts）は書き換えない。
 * そのため、特定のツールを再び有料にしたり、プランを増やしたりして上の設定が変われば、
 * 必要な説明は元の文言のまま自動で復活する。
 */

export interface CopyContext {
  /** 課金システム（料金・会員登録・ログイン導線）を提供しているか */
  billing: boolean;
  /** 広告を出しているか */
  ads: boolean;
  /** 説明の対象（ツール、またはカテゴリ）にプレミアム限定のツールが実際にあるか */
  premiumOnly: boolean;
  /** スタンダードプランを提供しているか */
  standardOffered: boolean;
}

const STANDARD_OFFERED = (OFFERED_PLAN_IDS as readonly string[]).includes("standard");

/** 指定のツールが、実際にプレミアム限定か（ALL_TOOLS_STANDARD などの運用スイッチを反映した tools から判定） */
function isPremiumOnlyTool(toolId: string): boolean {
  return tools.some((t) => t.id === toolId && t.requiredPlan === "premium");
}

/** 指定のカテゴリに、実際にプレミアム限定のツールがあるか */
function categoryHasPremiumOnlyTool(categoryId: string): boolean {
  return tools.some((t) => t.category === categoryId && t.status === "available" && t.requiredPlan === "premium");
}

function currentContext(premiumOnly: boolean): CopyContext {
  return {
    billing: featureFlags.billing,
    ads: featureFlags.ads,
    premiumOnly,
    standardOffered: STANDARD_OFFERED,
  };
}

/** 元の文言のまま使える状態か（調整が一切不要か） */
function isOriginalState(ctx: CopyContext): boolean {
  return ctx.billing && ctx.ads && ctx.premiumOnly && ctx.standardOffered;
}

/** 文の差し替えルール。from を含む箇所を、resolve が返す文へ置き換える。undefined は「そのまま」、"" は削除。 */
interface TextRule {
  from: string;
  resolve: (ctx: CopyContext) => string | undefined;
}

const FREE_OK = "はい。会員登録なしで、無料でご利用いただけます。";
const FREE_ANSWER_ADS_NOTE = "処理したファイルのダウンロード時に、広告の視聴が必要になる場合があります。";

/** 「無料プランでも使えますか？」への答え（プレミアム限定ではないツール用） */
function freeToolAnswer(ctx: CopyContext): string {
  return ctx.ads && ctx.billing ? `${FREE_OK}${FREE_ANSWER_ADS_NOTE}` : FREE_OK;
}

/** プレミアム専用を言う必要がない（課金オフ、または実際に限定ではない）状態か */
function notPremiumOnly(ctx: CopyContext): boolean {
  return !ctx.billing || !ctx.premiumOnly;
}

// 上から順に適用する。長い文を先に置くこと（短い文が長い文の一部になっているため）。
const TEXT_RULES: TextRule[] = [
  // ---- ツール個別（tool-content.ts）----
  {
    from: "このツールはプレミアムプラン専用の機能です。スタンダードプランや広告視聴による無料利用の対象には含まれません。",
    resolve: (ctx) => {
      if (notPremiumOnly(ctx)) return freeToolAnswer(ctx);
      if (ctx.standardOffered) return ctx.ads ? undefined : "このツールはプレミアムプラン専用の機能です。スタンダードプランの対象には含まれません。";
      return ctx.ads
        ? "このツールはプレミアムプラン専用の機能です。広告視聴による無料利用の対象には含まれません。"
        : "このツールはプレミアムプラン専用の機能です。";
    },
  },
  {
    from: "このツールはプレミアムプラン専用の機能です。",
    resolve: (ctx) => (notPremiumOnly(ctx) ? freeToolAnswer(ctx) : undefined),
  },
  {
    from: "プレミアムプランで利用できます。",
    resolve: (ctx) => (notPremiumOnly(ctx) ? "会員登録なしで、無料で利用できます。" : undefined),
  },
  {
    from: "はい。無料プランでは広告の表示が入りますが、そのままご利用いただけます。スタンダードプラン以上では広告なしで使えます。",
    resolve: (ctx) => {
      if (!ctx.billing) return FREE_OK;
      if (!ctx.ads) return "はい。無料プランでも、そのままご利用いただけます。";
      return ctx.standardOffered
        ? undefined
        : "はい。無料プランでは広告の表示が入りますが、そのままご利用いただけます。プレミアムプランでは広告なしで使えます。";
    },
  },
  {
    from: "無料プランは広告視聴で1ページずつ、スタンダードは広告なしで1ページずつ（ともに利用回数の上限なし）、プレミアムはページ数・回数とも無制限です。",
    resolve: (ctx) => {
      if (!ctx.billing) return "1回に処理できるのは1ページまでで、利用回数の上限はありません。";
      if (!ctx.standardOffered) {
        return ctx.ads
          ? "無料プランは広告視聴で1ページずつ（利用回数の上限なし）、プレミアムプランはページ数・回数とも無制限です。"
          : "無料プランは1回1ページまで（利用回数の上限なし）、プレミアムプランはページ数・回数とも無制限です。";
      }
      return ctx.ads ? undefined : "無料プラン・スタンダードは1ページずつ（ともに利用回数の上限なし）、プレミアムはページ数・回数とも無制限です。";
    },
  },
  {
    from: "無料プランの場合は広告を視聴して利用権を取得します（スタンダード・プレミアムプランでは不要です）。",
    resolve: (ctx) => {
      if (!ctx.billing || !ctx.ads) return "";
      return ctx.standardOffered ? undefined : "無料プランの場合は広告を視聴して利用権を取得します（プレミアムプランでは不要です）。";
    },
  },
  {
    from: "ただし1回に処理できるページ数はプランによって異なります（次の質問をご覧ください）。例えばプレミアムプランで1ページ2人分のテンプレートを10ページのPDFへ適用すると、最大20人分をまとめて出力できます。",
    resolve: (ctx) => {
      if (!ctx.billing) return "ただし1回に処理できるページ数には上限があります（次の質問をご覧ください）。";
      return ctx.standardOffered
        ? undefined
        : "ただし1回に処理できるページ数はプランによって異なります（次の質問をご覧ください）。例えばプレミアムプランで1ページ2人分のテンプレートを10ページのPDFへ適用すると、最大20人分をまとめて出力できます。";
    },
  },
  {
    from: "自動抽出・テンプレートのどちらのモードも、無料プラン・スタンダードプランは1回あたり1ページまでです（複数ファイルを選んだ場合も合計1ページまでです）。プレミアムプランはページ数の制限がありません。",
    resolve: (ctx) => {
      if (!ctx.billing) return "自動抽出・テンプレートのどちらのモードも、1回あたり1ページまでです（複数ファイルを選んだ場合も合計1ページまでです）。";
      return ctx.standardOffered
        ? undefined
        : "自動抽出・テンプレートのどちらのモードも、無料プランは1回あたり1ページまでです（複数ファイルを選んだ場合も合計1ページまでです）。プレミアムプランはページ数の制限がありません。";
    },
  },
  {
    from: "ログイン不要でご利用いただけます。1ページ処理するごとに広告の視聴が必要です（視聴後、その場で1ページ分を処理できます）。1日あたりの利用回数に上限はありません。",
    resolve: (ctx) => (ctx.ads ? undefined : "ログイン不要でご利用いただけます。1回あたり1ページまでで、1日あたりの利用回数に上限はありません。"),
  },
  {
    from: "ページ数・1日の回数ともに制限はありません。広告も表示されません。",
    resolve: (ctx) => (ctx.ads ? undefined : "ページ数・1日の回数ともに制限はありません。"),
  },

  // ---- カテゴリ（category-content.ts）----
  { from: "OCRなど一部の高度な機能はプレミアムプラン専用です。", resolve: (ctx) => (notPremiumOnly(ctx) ? "" : undefined) },
  { from: "PDFの表をExcelに変換する機能はプレミアムプラン専用です。", resolve: (ctx) => (notPremiumOnly(ctx) ? "" : undefined) },
  {
    from: "PDF→Word変換はプレミアムプラン専用、Word段落整理・番号振り直しは無料でご利用いただけます。",
    resolve: (ctx) =>
      notPremiumOnly(ctx) ? "PDF→Word変換も、Word段落整理・番号振り直しも、会員登録なしで無料でご利用いただけます。" : undefined,
  },
  {
    from: "動画ツールはプレミアムプラン専用です。",
    resolve: (ctx) => (notPremiumOnly(ctx) ? "動画ツールも、会員登録なしで無料でご利用いただけます。" : undefined),
  },
  {
    from: "無料プランでは広告が表示され、スタンダードプラン以上では広告なしで使えます。",
    resolve: (ctx) => {
      if (!ctx.billing) return "会員登録なしで、無料でご利用いただけます。";
      if (!ctx.ads) return "無料プランでも、そのままご利用いただけます。";
      return ctx.standardOffered ? undefined : "無料プランでは広告が表示され、プレミアムプランでは広告なしで使えます。";
    },
  },
  {
    from: "見積書・請求書・注文書の作成はプレミアムプラン専用、それ以外の大半のツールは無料でご利用いただけます。",
    resolve: (ctx) => (notPremiumOnly(ctx) ? "見積書・請求書・注文書の作成を含め、会員登録なしで無料でご利用いただけます。" : undefined),
  },
  { from: "無料・プレミアムツールの一覧です。", resolve: (ctx) => (notPremiumOnly(ctx) ? "無料ツールの一覧です。" : undefined) },

  // ---- 記入済みPDF→Excel（「AIで項目を読み取る」は課金オンのときだけ提供）----
  // 課金オンの文言が元の文章。課金オフのときだけ、AIに触れない（AIを使わない）文言へ差し替える。
  {
    from: "通常の変換（自動抽出・テンプレート）は、AIを使いません。文字の読み取り（OCR）も項目の整理も、ブラウザの中で、座標に基づく決まった手順で行います。プレミアムプランの「AIで項目を読み取る」を使うときだけ、送る内容を確認して同意したうえで、文字情報のあるPDFの文字（5ページ・6,000文字まで）を外部のAIサービスへ送ります。",
    resolve: (ctx) =>
      ctx.billing
        ? undefined
        : "このツールは、AIによる読み取り補助や外部のAIサービスを使いません。文字の読み取り（OCR）も項目の整理も、ブラウザの中で、座標に基づく決まった手順で行います。",
  },

  // ---- 「サーバーへ送信されない」という説明（課金オンのときは、AI利用時の例外を書く。オフのときは従来の文言）----
  { from: "いいえ。通常の変換では、PDFの読み込み・OCR・Excel生成はすべてブラウザ内で行われ、ファイルの内容やOCRの読み取り結果、生成したExcelファイルがMr.Sattoのサーバーへ送信・保存されることはありません。「AIで項目を読み取る」を使う場合だけ、画面で確認して同意した文字が、AIの処理のためにMr.Sattoのサーバーを経由して外部のAIサービスへ送られます（保存はしません）。テンプレートの入力枠の設定も、ページを離れると保持されない一時的なものです。", resolve: (ctx) => (ctx.billing ? undefined : "いいえ。PDFの読み込み・OCR・Excel生成はすべてブラウザ内で行われ、ファイルの内容やOCRの読み取り結果、生成したExcelファイルがMr.Sattoのサーバーへ送信・保存されることはありません。テンプレートの入力枠の設定も、ページを離れると保持されない一時的なものです。") },
  { from: "いいえ。通常の変換は、すべてお使いのブラウザの中で行われ、ファイルの内容がMr.Sattoのサーバーへ送信されることはありません。「AIで表を読み取る」（プレミアム・任意）を使う場合だけ、画面で確認して同意したPDFの文字が、AIの処理のためにMr.Sattoのサーバーを経由して外部のAIサービスへ送られます（保存はしません。PDFファイルそのものや画像は送りません）。処理が終わっても、ページを閉じればデータはブラウザ上から消えます。", resolve: (ctx) => (ctx.billing ? undefined : "いいえ。このツールの処理はすべてお使いのブラウザの中で行われ、ファイルの内容がMr.Sattoのサーバーへ送信されることはありません。処理が終わっても、ページを閉じればデータはブラウザ上から消えます。") },

  // ---- PowerPoint白黒反転（「AIの判断で、きれいに反転する」は課金オンのときだけ提供）----
  {
    from: "さらに、にじみをもっと減らしたいときは、プレミアムプランの「AIの判断で、きれいに反転する」をお使いください。AIが画像の中の文字の位置を見つけ、その範囲の文字のふちの色のにじみや、文字に重なった細い色を、白黒にそろえて反転します。文字の書き換えや画像の作り直しはせず、位置やフォントは元の画像のままです。通常の変換との違いは、画面で並べて確認できます。",
    resolve: (ctx) => (ctx.billing ? undefined : ""),
  },
  {
    from: "さらにきれいに反転したいときは、プレミアムプランの「AIの判断で、きれいに反転する」を使います（任意）。",
    resolve: (ctx) => (ctx.billing ? undefined : ""),
  },
  {
    from: "通常の変換は、読み込みから変換、保存まですべてお使いのブラウザの中で行い、ファイルや画像が外部に送信・保存されることはありません。プレミアムプランの「AIの判断で、きれいに反転する」を、ご自身で選び、送る画像を確認して同意して実行したときだけ、縮小した画像がAIサービス（OpenAI）に送られます。PowerPointファイルそのものは送信されません。",
    resolve: (ctx) => (ctx.billing ? undefined : "いいえ。読み込みから変換、保存まですべてお使いのブラウザの中で行い、ファイルや画像が外部に送信・保存されることはありません。AIや外部サービスも使いません。"),
  },
  // ---- 年度カレンダー作成（AIで読み取る機能は課金オンのときだけ提供。文言は fiscal-calendar-copy.ts）----
  // 課金オンの文言が元の文章。課金オフのときだけ、AI・画像に触れない文言へ差し替える。
  ...FISCAL_CALENDAR_COPY_PAIRS.map((pair): TextRule => ({ from: pair.on, resolve: (ctx) => (ctx.billing ? undefined : pair.off) })),
];

/** 課金オフのとき、まるごと取り除くFAQの質問 */
const FAQ_QUESTIONS_REMOVED_WHEN_BILLING_OFF = new Set([
  "AIで項目を読み取る機能はありますか？",
  "AIで表を読み取る機能はありますか？",
  "無料プランではどのように使えますか？",
  "スタンダードプランではどのように使えますか？",
  "プレミアムプランの制限は？",
]);

/** スタンダードプランを提供していないとき、まるごと取り除くFAQの質問 */
const FAQ_QUESTIONS_REMOVED_WHEN_STANDARD_NOT_OFFERED = new Set(["スタンダードプランではどのように使えますか？"]);

/** 課金オフのとき、質問文を書き換える */
const FAQ_QUESTION_REWRITES_WHEN_BILLING_OFF: Record<string, string> = {
  "無料プランでも使えますか？": "無料で使えますか？",
};

/** 課金オン・スタンダードプランを提供していないとき、質問文を書き換える（画面・料金ページの「プレミアム」表記に合わせる） */
const FAQ_QUESTION_REWRITES_WHEN_STANDARD_NOT_OFFERED: Record<string, string> = {
  "プレミアムプランの制限は？": "プレミアムプランの制限は？",
};

export function adaptTextWith(text: string, ctx: CopyContext): string {
  if (isOriginalState(ctx)) return text;
  let result = text;
  for (const rule of TEXT_RULES) {
    if (!result.includes(rule.from)) continue;
    const to = rule.resolve(ctx);
    if (to === undefined) continue;
    result = result.split(rule.from).join(to);
  }
  return result;
}

export function adaptToolSeoContentWith(content: ToolSeoContent, ctx: CopyContext): ToolSeoContent {
  if (isOriginalState(ctx)) return content;
  const adapt = (text: string) => adaptTextWith(text, ctx);
  const rewriteQuestion = (question: string): string => {
    if (!ctx.billing) return FAQ_QUESTION_REWRITES_WHEN_BILLING_OFF[question] ?? adapt(question);
    if (!ctx.standardOffered) return FAQ_QUESTION_REWRITES_WHEN_STANDARD_NOT_OFFERED[question] ?? adapt(question);
    return adapt(question);
  };
  return {
    ...content,
    metaTitle: adapt(content.metaTitle),
    metaDescription: adapt(content.metaDescription),
    lead: adapt(content.lead),
    howTo: content.howTo.map(adapt).filter((step) => step.trim() !== ""),
    faq: content.faq
      .filter((item) => !(!ctx.billing && FAQ_QUESTIONS_REMOVED_WHEN_BILLING_OFF.has(item.question)))
      .filter((item) => !(!ctx.standardOffered && FAQ_QUESTIONS_REMOVED_WHEN_STANDARD_NOT_OFFERED.has(item.question)))
      .map((item) => ({
        question: rewriteQuestion(item.question),
        answer: adapt(item.answer),
      }))
      .filter((item) => item.answer.trim() !== ""),
  };
}

export function adaptCategorySeoContentWith(content: CategorySeoContent, ctx: CopyContext): CategorySeoContent {
  if (isOriginalState(ctx)) return content;
  const adapted: CategorySeoContent = { ...content };
  for (const key of Object.keys(adapted) as (keyof CategorySeoContent)[]) {
    const value = adapted[key];
    if (typeof value === "string") {
      (adapted as unknown as Record<string, unknown>)[key] = adaptTextWith(value, ctx).replace(/\s+$/, "");
    }
  }
  return adapted;
}

/** 現在の設定でのツール個別ページの説明文。toolId のツールが実際にプレミアム限定かどうかも反映する。 */
export function adaptToolSeoContent(content: ToolSeoContent, toolId: string): ToolSeoContent {
  return adaptToolSeoContentWith(content, currentContext(isPremiumOnlyTool(toolId)));
}

/** 現在の設定でのカテゴリページの説明文。カテゴリ内に実際にプレミアム限定のツールがあるかどうかも反映する。 */
export function adaptCategorySeoContent(content: CategorySeoContent, categoryId: string): CategorySeoContent {
  return adaptCategorySeoContentWith(content, currentContext(categoryHasPremiumOnlyTool(categoryId)));
}
