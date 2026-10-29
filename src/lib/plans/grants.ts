import type { Plan } from "./types";

/**
 * プレミアムの「無料付与」と「3日間の無料お試し」の、純粋な判定（画面・DBに依存しない。単体テストできる）。
 * 読み書きは src/lib/plans/grant-store.ts（server-only）が行う。
 *
 * - 付与は Stripe の契約とは別。期限（endsAt）を過ぎると、自動で無料に戻る。
 * - Stripe の契約でプレミアムが有効なときは、そちらが優先（付与は、ただの追加の権利）。
 */
export type GrantSource = "admin" | "trial";

export interface PremiumGrant {
  source: GrantSource;
  /** ISO 8601 */
  startsAt: string;
  endsAt: string;
}

export const TRIAL_DAYS = 3;
/** 管理者が一度に付与できる最長の日数（入力ミスで何年分も付与してしまうのを防ぐ） */
export const ADMIN_GRANT_MAX_DAYS = 366;
/** 管理者が選べる日数（画面の選択肢） */
export const ADMIN_GRANT_DAY_CHOICES = [3, 7, 14, 30, 90, 180, 365] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export function isGrantActive(grant: PremiumGrant | null, nowMs: number): boolean {
  if (!grant) return false;
  const start = Date.parse(grant.startsAt);
  const end = Date.parse(grant.endsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= nowMs && nowMs < end;
}

/** 付与の終了時刻（ミリ秒）。日数は 1〜ADMIN_GRANT_MAX_DAYS の整数だけ（それ以外は null） */
export function grantEndMs(nowMs: number, days: number): number | null {
  if (!Number.isInteger(days) || days < 1 || days > ADMIN_GRANT_MAX_DAYS) return null;
  return nowMs + days * DAY_MS;
}

/**
 * 付与を加味したプラン。Stripeの契約（subscriptionPlan）がプレミアムならそのまま。
 * そうでなくて有効な付与があれば premium。付与はプレミアムより下のプランを引き上げるだけで、下げることはない。
 */
export function applyGrantToPlan(subscriptionPlan: Plan, grant: PremiumGrant | null, nowMs: number): Plan {
  if (subscriptionPlan === "premium") return subscriptionPlan;
  return isGrantActive(grant, nowMs) ? "premium" : subscriptionPlan;
}

/** 付与の期限を、画面に出す日付の文字列にする（例: 2026/11/5）。日本時間 */
export function formatGrantEnd(endsAt: string): string {
  const d = new Date(endsAt);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Tokyo" }).format(d);
}

export const GRANT_SOURCE_LABEL: Record<GrantSource, string> = {
  admin: "無料付与",
  trial: "無料お試し",
};

/** AIの利用枠（マイクロドル）。無料お試しは、費用を抑えるため、通常の月間の枠より小さくする */
export const AI_TRIAL_LIMIT_MICRO_USD = 500_000;

/**
 * 無料お試しの案内の状態（画面の出し分け）。
 *  - guest: 未ログイン（会員登録をすすめる）
 *  - available: ログイン済みで、まだ使っていない（ボタンを出す）
 *  - active: いま、付与（お試し・管理者の付与）で、プレミアムを使えている
 *  - hidden: 出さない（すでにStripeの契約でプレミアム、または、お試しを使い終わった）
 */
export type TrialOfferState = "guest" | "available" | "active" | "hidden";

export function trialOfferState(args: { signedIn: boolean; subscriptionPremium: boolean; grantActive: boolean; trialUsed: boolean }): TrialOfferState {
  if (!args.signedIn) return "guest";
  if (args.subscriptionPremium) return "hidden";
  if (args.grantActive) return "active";
  return args.trialUsed ? "hidden" : "available";
}
