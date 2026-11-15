import { VERIFICATION_MAX_AGE_MS } from "./config";

/**
 * 有料プランの機能を使えるかの判定（純粋な関数。サーバーで使う。テストしやすいようにDBやCookieに触れない）。
 *
 * 次をすべて満たすときだけ ok：
 *   1. 有料の契約（または無料付与・無料お試し）が有効
 *   2. パスキーを1つ以上登録している
 *   3. この端末が登録端末（最大2台）の1つ
 *   4. この端末で、パスキーによる本人確認が済んでいて（12時間以内）、同時利用のロックを持っている
 */
export type PaidAccessStatus =
  /** 使える */
  | "ok"
  /** 有料の契約がない（判定の対象外） */
  | "not_paid"
  /** 仕組みがオフ（機能スイッチ）。今までどおり使える */
  | "disabled"
  /** パスキーが未登録 */
  | "needs_passkey"
  /** この端末が未登録（または解除された） */
  | "needs_device"
  /** この端末でのパスキーの本人確認が必要（ブラウザを閉じた・12時間たった・ロックが空いている） */
  | "needs_verification"
  /** 別の端末で利用中 */
  | "in_use_elsewhere"
  /** 状態を確かめられなかった（DBの不調など）。安全のため、有料機能は開放しない */
  | "unavailable";

export type LeaseState = "mine" | "free" | "other" | "none";

export interface PaidAccessInput {
  contractPaid: boolean;
  enabled: boolean;
  /** 状態を読めなかったときは null */
  state: {
    credentialCount: number;
    deviceActive: boolean;
    lease: LeaseState;
    verifiedAtMs: number | null;
  } | null;
  nowMs: number;
}

export function decidePaidAccess(input: PaidAccessInput): PaidAccessStatus {
  if (!input.contractPaid) return "not_paid";
  if (!input.enabled) return "disabled";
  const s = input.state;
  if (!s) return "unavailable";
  if (s.credentialCount <= 0) return "needs_passkey";
  if (!s.deviceActive) return "needs_device";
  if (s.lease === "mine") {
    if (s.verifiedAtMs === null || input.nowMs - s.verifiedAtMs > VERIFICATION_MAX_AGE_MS) return "needs_verification";
    return "ok";
  }
  if (s.lease === "other") return "in_use_elsewhere";
  return "needs_verification";
}

/** 有料機能を開放してよいか */
export function paidAccessGranted(status: PaidAccessStatus): boolean {
  return status === "ok" || status === "disabled";
}

/** 利用者向けの短い案内（アカウント画面・ツールの画面で使う） */
export const PAID_ACCESS_MESSAGE: Record<Exclude<PaidAccessStatus, "ok" | "not_paid" | "disabled">, string> = {
  needs_passkey: "有料プランを使うには、パスキーの登録が必要です。登録が終わるとすぐに使えます（ご契約はそのまま有効です）。",
  needs_device: "この端末は、まだ登録されていません。パスキーで本人確認をして、この端末を登録してください（登録できる端末は最大2台です）。",
  needs_verification: "有料プランの機能を使うには、この端末でパスキーによる本人確認をしてください。",
  in_use_elsewhere:
    "このアカウントは別の端末で利用中です。先に利用中の端末からログアウトしてください。この端末で続けて使う場合は、パスキーで本人確認をすると、この端末に切り替わります（利用中の端末の利用は終わります）。",
  unavailable: "ご利用状況を確認できませんでした。しばらくしてから、もう一度お試しください。",
};
