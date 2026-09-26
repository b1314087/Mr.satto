"use server";

import { getServerPlan } from "@/lib/plans/current-plan";
import type { Plan } from "@/lib/plans/types";
import { checkPageCredit, consumePageCredit } from "./credit-actions";
import { getStandardDailyUsageCount, incrementStandardDailyUsage, STANDARD_DAILY_FREE_USES } from "./daily-usage";
import { PDF_TO_EXCEL_CREDIT_MAX_PAGES } from "./usage-cookie";

/**
 * 記入済みPDF→Excel専用の利用可否判定をまとめたServer Actions。
 *
 * この1ツールは、既存の汎用 <ToolAccessGate>（Standard対象ツール全体・
 * 15分間のリワード広告ゲート）とは条件が根本的に異なる
 * （ツール専用・ページ数ベース・Standardは1日10回まで無償）ため、
 * src/app/tools/[tool]/page.tsx でこのツールIDのみ <ToolAccessGate> を
 * バイパスし、ツール自身のクライアントコンポーネントがここのServer Actionsを
 * 直接呼び出して可否を判定する（Client ComponentからServer Actionを
 * 直接呼ぶのはNext.jsの標準的な構成であり、tool-registry.tsxの
 * dynamic importの形は変更不要）。
 *
 * 料金プラン別の実際の挙動（開発指示書4〜9章）:
 *   Free      : 常にリワード広告視聴 → 最大3ページの一時利用権が必要
 *   Standard  : 1日10回まで広告不要（1回あたり最大3ページ）。
 *               11回目以降はFreeと同じ「広告視聴→3ページ」条件にフォールバック
 *   Premium   : ページ数・回数の制限なし。広告不要
 */

export interface FilledPdfToExcelUsageStatus {
  plan: Plan;
  /** 1回の処理で許可される最大ページ数。Premiumはnull（制限なし） */
  maxPagesPerUse: number | null;
  /** この状態のまま処理を始めようとした場合、広告視聴が必要か */
  requiresAd: boolean;
  /** 既に有効な（広告視聴済みの）page creditを保持しているか */
  creditActive: boolean;
  /** Standardプランの当日利用回数（それ以外のプランではnull） */
  dailyUsed: number | null;
  /** Standardプランの1日あたり無償回数上限（それ以外のプランではnull） */
  dailyLimit: number | null;
}

/** ツールのマウント時など、状態表示のためだけに呼ぶ（何も消費しない） */
export async function getFilledPdfToExcelUsageStatus(): Promise<FilledPdfToExcelUsageStatus> {
  const { plan } = await getServerPlan();
  const credit = await checkPageCredit();

  if (plan === "premium") {
    return {
      plan,
      maxPagesPerUse: null,
      requiresAd: false,
      creditActive: credit.active,
      dailyUsed: null,
      dailyLimit: null,
    };
  }

  if (plan === "standard") {
    const dailyUsed = await getStandardDailyUsageCount();
    const withinDailyQuota = dailyUsed < STANDARD_DAILY_FREE_USES;
    return {
      plan,
      maxPagesPerUse: PDF_TO_EXCEL_CREDIT_MAX_PAGES,
      requiresAd: !withinDailyQuota && !credit.active,
      creditActive: credit.active,
      dailyUsed,
      dailyLimit: STANDARD_DAILY_FREE_USES,
    };
  }

  // free（未ログイン含む）
  return {
    plan,
    maxPagesPerUse: PDF_TO_EXCEL_CREDIT_MAX_PAGES,
    requiresAd: !credit.active,
    creditActive: credit.active,
    dailyUsed: null,
    dailyLimit: null,
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

  // Free・Standardは共通して1回あたり最大3ページ
  if (pageCount > PDF_TO_EXCEL_CREDIT_MAX_PAGES) {
    return { allowed: false, reason: "page-limit-exceeded", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }

  if (plan === "standard") {
    const dailyUsed = await getStandardDailyUsageCount();
    if (dailyUsed < STANDARD_DAILY_FREE_USES) {
      const result = await incrementStandardDailyUsage();
      if (result !== null) {
        return { allowed: true, maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
      }
      // 利用回数管理サービスが利用できない場合は、安全側に倒して
      // Freeと同じ「広告視聴が必要」条件へフォールバックする
      // （無制限に許可してしまうことを避ける）。
    }
  }

  // Free、またはStandardで1日の無償回数を使い切った/回数管理が利用できない場合
  const creditConsumed = await consumePageCredit();
  if (!creditConsumed) {
    return { allowed: false, reason: "ad-required", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }
  return { allowed: true, maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
}
