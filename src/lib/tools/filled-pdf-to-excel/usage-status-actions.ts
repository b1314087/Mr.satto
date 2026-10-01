"use server";

import { getServerPlan } from "@/lib/plans/current-plan";
import type { Plan } from "@/lib/plans/types";
import { checkPageCredit, consumePageCredit } from "./credit-actions";
import { getStandardDailyUsageCount, incrementStandardDailyUsage, STANDARD_DAILY_FREE_USES } from "./daily-usage";
import { getFreeDailyUsageCount, incrementFreeDailyUsage } from "./free-daily-usage-actions";
import { PDF_TO_EXCEL_CREDIT_MAX_PAGES, PDF_TO_EXCEL_FREE_DAILY_USES } from "./usage-cookie";

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
 * 料金プラン別の実際の挙動（利用制限見直しで確定した仕様）:
 *   Free      : 常にリワード広告視聴 → 最大3ページの一時利用権が必要。
 *               さらに1日あたりの回数上限（PDF_TO_EXCEL_FREE_DAILY_USES）を
 *               超えた場合は、その日はもう広告を視聴しても利用できない。
 *   Standard  : 1日5回まで広告不要（1回あたり最大3ページ）。
 *               6回目以降は広告視聴によるフォールバックを行わず、
 *               翌日まで利用不可（旧仕様の「広告視聴で延長できる」挙動は廃止）。
 *   Premium   : ページ数・回数の制限なし。広告不要。
 */

export interface FilledPdfToExcelUsageStatus {
  plan: Plan;
  /** 1回の処理で許可される最大ページ数。Premiumはnull（制限なし） */
  maxPagesPerUse: number | null;
  /** 今、広告視聴によって新たな利用権を得られる状態か（1日の上限に達した後はfalseになる） */
  requiresAd: boolean;
  /** 既に有効な（広告視聴済みの）page creditを保持しているか */
  creditActive: boolean;
  /** Free・Standardの当日利用回数（Premiumではnull） */
  dailyUsed: number | null;
  /** Free・Standardの1日あたり回数上限（Premiumではnull） */
  dailyLimit: number | null;
  /** 1日あたりの回数上限に達しているか（Free・Standard共通。Premiumでは常にfalse） */
  dailyLimitReached: boolean;
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
      dailyLimitReached: false,
    };
  }

  if (plan === "standard") {
    const dailyUsed = await getStandardDailyUsageCount();
    const dailyLimitReached = dailyUsed >= STANDARD_DAILY_FREE_USES;
    return {
      plan,
      maxPagesPerUse: PDF_TO_EXCEL_CREDIT_MAX_PAGES,
      // Standardは新仕様で「広告なし」固定のため、1日の上限に達しても
      // 広告への切り替えは提示しない（翌日まで利用不可）。
      requiresAd: false,
      creditActive: credit.active,
      dailyUsed,
      dailyLimit: STANDARD_DAILY_FREE_USES,
      dailyLimitReached,
    };
  }

  // free（未ログイン含む）
  const dailyUsed = await getFreeDailyUsageCount();
  const dailyLimitReached = dailyUsed >= PDF_TO_EXCEL_FREE_DAILY_USES;
  return {
    plan,
    maxPagesPerUse: PDF_TO_EXCEL_CREDIT_MAX_PAGES,
    // 1日の上限に達した後は、新たに広告を見ても利用権を得られないようにする
    // （「広告を見れば無限に使える」状態を避ける）。
    requiresAd: !credit.active && !dailyLimitReached,
    creditActive: credit.active,
    dailyUsed,
    dailyLimit: PDF_TO_EXCEL_FREE_DAILY_USES,
    dailyLimitReached,
  };
}

export type ConsumeFilledPdfToExcelFailureReason = "page-limit-exceeded" | "ad-required" | "daily-limit-exceeded";

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
    if (dailyUsed >= STANDARD_DAILY_FREE_USES) {
      // 新仕様: 上限到達後は広告へのフォールバックを行わず、ここで確定的に拒否する。
      return { allowed: false, reason: "daily-limit-exceeded", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
    }
    const result = await incrementStandardDailyUsage();
    if (result !== null) {
      return { allowed: true, maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
    }
    // 利用回数管理サービス（Supabase RPC）が利用できない場合は、安全側に倒して
    // 「本日は利用不可」として扱う（旧仕様にあった広告視聴へのフォールバックは
    // 新仕様の「Standardは広告なし」と矛盾するため行わない）。
    return { allowed: false, reason: "daily-limit-exceeded", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }

  // free（未ログイン含む）: 1日の回数上限に達している場合は、広告視聴による
  // 利用権の消費自体を行わせない（上限到達後は新たな広告視聴を提示しない）。
  const dailyUsed = await getFreeDailyUsageCount();
  if (dailyUsed >= PDF_TO_EXCEL_FREE_DAILY_USES) {
    return { allowed: false, reason: "daily-limit-exceeded", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }

  const creditConsumed = await consumePageCredit();
  if (!creditConsumed) {
    return { allowed: false, reason: "ad-required", maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
  }

  await incrementFreeDailyUsage();
  return { allowed: true, maxPages: PDF_TO_EXCEL_CREDIT_MAX_PAGES };
}
