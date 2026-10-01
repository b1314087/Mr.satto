"use server";

import { getServerPlan } from "@/lib/plans/current-plan";
import type { Plan } from "@/lib/plans/types";
import { checkPageCredit, consumePageCredit } from "./credit-actions";
import { PDF_TO_EXCEL_CREDIT_MAX_PAGES } from "./usage-cookie";

/**
 * 記入済みPDF→Excel専用の利用可否判定をまとめたServer Actions。
 *
 * この1ツールは、既存の汎用 <ToolAccessGate>（Standard対象ツール全体・
 * 15分間のリワード広告ゲート）とは条件が根本的に異なるため、
 * src/app/tools/[tool]/page.tsx でこのツールIDのみ <ToolAccessGate> を
 * バイパスし、ツール自身のクライアントコンポーネントがここのServer Actionsを
 * 直接呼び出して可否を判定する（Client ComponentからServer Actionを
 * 直接呼ぶのはNext.jsの標準的な構成であり、tool-registry.tsxの
 * dynamic importの形は変更不要）。
 *
 * 料金プラン別の実際の挙動（利用制限見直し・2026年第2版で確定した仕様）:
 *   Free      : 常にリワード広告視聴 → 1回・1ページの一時利用権が必要。
 *               1ページ処理するたびに広告が必要（1回使い切りの利用権のため）。
 *               1日あたりの回数上限は設けない。
 *   Standard  : 広告なし、1回あたり最大1ページ。1日あたりの回数上限は
 *               設けない（旧仕様にあった1日5回制限・上限到達後の
 *               広告視聴フォールバックはいずれも廃止）。
 *   Premium   : ページ数・回数の制限なし。広告不要。
 *
 * 旧実装（利用制限見直し・第1版）にあった、Free向けの署名付きCookieによる
 * 1日3回制限（free-daily-usage-actions.ts）、Standard向けのSupabase
 * tool_usage_daily による1日5回制限（daily-usage.ts）は、いずれも本仕様で
 * 撤廃されたため、該当ファイルごと削除し、ここでも呼び出していない
 * （再実装しない）。
 */

export interface FilledPdfToExcelUsageStatus {
  plan: Plan;
  /** 1回の処理で許可される最大ページ数。Premiumはnull（制限なし） */
  maxPagesPerUse: number | null;
  /** 今、広告視聴によって新たな利用権を得られる状態か（Freeのみtrueになりうる） */
  requiresAd: boolean;
  /** 既に有効な（広告視聴済みの）page creditを保持しているか */
  creditActive: boolean;
}

/** ツールのマウント時など、状態表示のためだけに呼ぶ（何も消費しない） */
export async function getFilledPdfToExcelUsageStatus(): Promise<FilledPdfToExcelUsageStatus> {
  const { plan } = await getServerPlan();
  const credit = await checkPageCredit();

  if (plan === "premium") {
    return { plan, maxPagesPerUse: null, requiresAd: false, creditActive: credit.active };
  }

  if (plan === "standard") {
    // Standardは新仕様で「広告なし・1日あたりの回数上限なし」で固定。
    return { plan, maxPagesPerUse: PDF_TO_EXCEL_CREDIT_MAX_PAGES, requiresAd: false, creditActive: credit.active };
  }

  // free（未ログイン含む）。1日あたりの回数上限は設けないため、有効な
  // page creditを持っていない間は常に広告視聴が必要な状態になる。
  return {
    plan,
    maxPagesPerUse: PDF_TO_EXCEL_CREDIT_MAX_PAGES,
    requiresAd: !credit.active,
    creditActive: credit.active,
  };
}

export type ConsumeFilledPdfToExcelFailureReason = "page-limit-exceeded" | "ad-required";

export type ConsumeFilledPdfToExcelResult =
  | { allowed: true; maxPages: number | null }
  | { allowed: false; reason: ConsumeFilledPdfToExcelFailureReason; maxPages: number | null };

/**
 * 実際の処理（OCR/Excel生成）を開始する直前に、必ずこれを呼ぶ。
 * true が返った場合のみ、クライアント側は重い処理を開始してよい。
 *
 * pageCount には、クライアント側（pdfjsで既に読み込み済みのPDF）で
 * 数えたページ数をそのまま渡す。ファイルの中身自体はサーバーへ
 * 送信しない（ブラウザ内処理の原則）ため、ここで検証できるのは
 * 「利用権（広告視聴 or プラン）」のみであり、ページ数の妥当性は
 * 呼び出し側が渡した数値をそのまま信頼する（本人のブラウザ内で
 * 完結する処理のページ数を偽っても、他者や共有リソースへの実害がない）。
 */
export async function consumeFilledPdfToExcelUsage(pageCount: number): Promise<ConsumeFilledPdfToExcelResult> {
  const { plan } = await getServerPlan();

  if (plan === "premium") {
    return { allowed: true, maxPages: null };
  }

  // Free・Standardは共通して1回あたり最大1ページ
  if (pageCount > PDF_TO_EXCEL_CREDIT_MAX_PAGES) {
    return { allowed: false, reason: "page-limit-exceeded", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }

  if (plan === "standard") {
    // 新仕様: Standardは広告なし・1日あたりの回数上限なしで常に許可する。
    return { allowed: true, maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }

  // free（未ログイン含む）: 1日あたりの回数上限は設けないため、
  // 有効な広告視聴済みの利用権（page credit）があるかどうかだけを見る。
  const creditConsumed = await consumePageCredit();
  if (!creditConsumed) {
    return { allowed: false, reason: "ad-required", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }

  return { allowed: true, maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
}
