"use server";

import { cookies } from "next/headers";
import { issuePageCreditToken, verifyPageCreditToken } from "./credit-token";
import { PDF_TO_EXCEL_CREDIT_COOKIE_NAME, PDF_TO_EXCEL_CREDIT_DURATION_MS } from "./usage-cookie";

/**
 * 記入済みPDF→Excelの「リワード広告視聴 → 1回・最大3ページの利用権」を、
 * Cookieに保存されたHMAC署名付きトークンとして発行・確認・消費するServer Actions。
 *
 * src/lib/plans/temporary-access-actions.ts の grantTemporaryAccess()/
 * checkTemporaryAccess() と同じ形を踏襲しているが、意味論が異なる：
 *   - 既存のTemporary Accessは「時間の窓の間、繰り返し使える」権限
 *   - こちらは「1回使い切りの権利」。consumePageCredit() が呼ばれた時点で
 *     Cookie自体を削除し、二重処理・使い回しを防ぐ
 *
 * 「広告を見る前に処理を始めない」（開発指示書6章）ため、実際にファイルの
 * 処理を始める直前に必ず consumePageCredit() を呼び、成功した場合のみ
 * クライアント側の重い処理（OCR/Excel生成）へ進む設計にする。
 */

export interface PageCreditStatus {
  active: boolean;
  expiresAtMs: number | null;
}

/** リワード広告視聴が成功した直後に呼び、page creditを発行してCookieへ保存する */
export async function grantPageCredit(): Promise<PageCreditStatus> {
  const cookieStore = await cookies();

  // 既に有効なcreditが残っている場合は、それを使い回す（連打による
  // 「広告を見るたびに有効期限が延び続ける」ような不自然な状態を避ける）。
  const existing = verifyPageCreditToken(cookieStore.get(PDF_TO_EXCEL_CREDIT_COOKIE_NAME)?.value);
  if (existing.active) {
    return existing;
  }

  const token = issuePageCreditToken(PDF_TO_EXCEL_CREDIT_DURATION_MS);
  const check = verifyPageCreditToken(token);
  cookieStore.set(PDF_TO_EXCEL_CREDIT_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.ceil(PDF_TO_EXCEL_CREDIT_DURATION_MS / 1000),
    path: "/",
  });
  return check;
}

/** 現在page creditが有効かどうかを確認するだけ（消費しない）。UI表示用 */
export async function checkPageCredit(): Promise<PageCreditStatus> {
  const cookieStore = await cookies();
  return verifyPageCreditToken(cookieStore.get(PDF_TO_EXCEL_CREDIT_COOKIE_NAME)?.value);
}

/**
 * 実際の処理を開始する直前に呼ぶ。有効なcreditがあればCookieを削除して
 * 消費（1回使い切り）し、trueを返す。無効・期限切れならfalseを返し、
 * 呼び出し側は処理を開始してはならない。
 */
export async function consumePageCredit(): Promise<boolean> {
  const cookieStore = await cookies();
  const check = verifyPageCreditToken(cookieStore.get(PDF_TO_EXCEL_CREDIT_COOKIE_NAME)?.value);
  cookieStore.delete(PDF_TO_EXCEL_CREDIT_COOKIE_NAME);
  return check.active;
}
