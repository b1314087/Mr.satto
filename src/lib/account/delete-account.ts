import { isOpenSubscriptionStatus } from "@/lib/plans/effective-plan";

/**
 * アカウント削除の流れ（工程38）。通信は依存（deps）として受け取るので、Supabase・Stripeに接続せずに単体テストできる。
 * 実際の依存の実装は delete-account-actions.ts（Server Action）にある。
 *
 * 方針（課金中の扱いは「案A」＝契約が終わってから削除、を暫定の形としている。詳細は工程38の報告書）:
 *  - 削除できるのは、ログイン中の本人だけ。対象のユーザーIDは、検証済みのセッションから得る（フォームから受け取らない）。
 *  - 続いている契約がある間は削除しない。契約は先に（アカウント画面の管理画面から）解約し、契約が終わってから削除する。
 *    ここで契約を自動で解約したり、返金したりはしない（金銭に関わる不可逆な処理は、運営者の方針の確定後に別途）。
 *  - 本人確認として、確認の文言の入力と、パスワードの再入力を求める。
 *  - 削除の前に、Stripeの最新の契約状態を確認し（データベースの値が古い場合に備える）、決済の途中のセッションを失効させる。
 *    確認できなかったときは、削除しない（安全側）。
 *  - 削除は auth.users の削除1回で行う。関連するデータ（プロフィール・契約情報・利用状況・AI利用台帳・同意の記録）は、
 *    外部キーの連鎖削除で消える。途中まで削除された状態は残らない。
 *  - 同じ操作を繰り返しても安全（すでに削除済みなら成功として扱う）。
 *  - パスワード・トークンはログに出さない。
 */

/** 本人確認のために入力してもらう文言 */
export const DELETE_CONFIRMATION_WORD = "削除";

export type DeleteAccountErrorCode =
  | "unauthenticated"
  | "rate-limited"
  | "confirmation"
  | "password"
  | "contract-active"
  | "unavailable"
  | "failed";

export type DeleteAccountResult =
  | { status: "deleted" }
  | { status: "error"; code: DeleteAccountErrorCode; message: string };

export const DELETE_ACCOUNT_MESSAGES: Record<DeleteAccountErrorCode, string> = {
  unauthenticated: "ログインが必要です。ログインしてから、もう一度お試しください。",
  "rate-limited": "操作が多すぎます。しばらくしてから、もう一度お試しください。",
  confirmation: `確認の欄に「${DELETE_CONFIRMATION_WORD}」と入力してください。`,
  password: "パスワードが正しくありません。",
  "contract-active":
    "有料プランのご契約が続いているため、アカウントを削除できません。先にアカウント画面から解約し、契約期間が終了してから、あらためて削除してください。",
  unavailable: "現在、契約の状態を確認できないため、削除を進められません。しばらくしてから、もう一度お試しください。",
  failed: "アカウントの削除に失敗しました。しばらくしてから、もう一度お試しください。解決しない場合は、お問い合わせください。",
};

export interface StoredSubscription {
  status: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

/** Stripeでの確認結果。none = 続いている契約なし / open = 続いている契約あり / unverifiable = 確認できない（未設定など） */
export type StripeOpenCheck = "none" | "open" | "unverifiable";

export interface DeleteAccountDeps {
  /** ログイン中のユーザー（サーバーでセッションを検証したもの）。いなければ null */
  getCurrentUser(): Promise<{ id: string; email: string | null } | null>;
  isRateLimited(userId: string): boolean;
  /** パスワードが正しいか（再認証）。通信の失敗は例外 */
  verifyPassword(email: string, password: string): Promise<boolean>;
  /** データベース上の契約情報。読み取りに失敗したら例外 */
  getStoredSubscription(userId: string): Promise<StoredSubscription | null>;
  /** Stripe上で、続いている契約があるか。通信の失敗は例外 */
  checkStripeOpenSubscriptions(customerId: string): Promise<StripeOpenCheck>;
  /** 決済の途中（未完了）のCheckoutセッションを失効させる。失敗は例外 */
  expireOpenCheckoutSessions(customerId: string): Promise<void>;
  /** アカウントを削除する。すでに存在しなければ "not-found"。失敗は例外 */
  deleteUser(userId: string): Promise<"deleted" | "not-found">;
  /** ログイン状態（Cookie）を破棄する。失敗しても削除は成功として扱う */
  signOut(): Promise<void>;
  /** 個人情報（メールアドレス・パスワード）を含めずに記録する */
  log?(event: string, detail: Record<string, string>): void;
}

function fail(code: DeleteAccountErrorCode): DeleteAccountResult {
  return { status: "error", code, message: DELETE_ACCOUNT_MESSAGES[code] };
}

/** 契約が続いているか（データベース上の記録から） */
function storedContractIsOpen(sub: StoredSubscription | null): boolean {
  return !!sub && sub.status !== null && isOpenSubscriptionStatus(sub.status);
}

export async function runDeleteAccount(
  input: { confirmation: string; password: string },
  deps: DeleteAccountDeps,
): Promise<DeleteAccountResult> {
  // 1. 本人の確認（サーバーで検証したセッション）。対象は、必ずこのユーザー自身。
  const user = await deps.getCurrentUser();
  if (!user) return fail("unauthenticated");

  if (deps.isRateLimited(user.id)) return fail("rate-limited");

  // 2. 確認の文言とパスワード（再認証）
  if (input.confirmation.trim() !== DELETE_CONFIRMATION_WORD) return fail("confirmation");
  if (!user.email || input.password.length === 0) return fail("password");
  try {
    if (!(await deps.verifyPassword(user.email, input.password))) return fail("password");
  } catch {
    return fail("unavailable");
  }

  // 3. 契約の確認（データベース → Stripe → 決済の途中のセッションを失効 → もう一度Stripe）
  try {
    const stored = await deps.getStoredSubscription(user.id);
    if (storedContractIsOpen(stored)) return fail("contract-active");

    if (stored?.stripeCustomerId) {
      const first = await deps.checkStripeOpenSubscriptions(stored.stripeCustomerId);
      if (first === "open") return fail("contract-active");
      // Stripeで確認できないとき: 契約の記録（Stripe側の契約ID）が残っているなら、安全側で止める。
      if (first === "unverifiable" && stored.stripeSubscriptionId) return fail("unavailable");

      if (first !== "unverifiable") {
        // 決済の途中のセッションが、削除の直後に完了して契約が作られるのを防ぐ。
        await deps.expireOpenCheckoutSessions(stored.stripeCustomerId);
        const second = await deps.checkStripeOpenSubscriptions(stored.stripeCustomerId);
        if (second === "open") return fail("contract-active");
        if (second === "unverifiable") return fail("unavailable");
      }
    }
  } catch (error) {
    deps.log?.("subscription-check-failed", { userId: user.id, kind: error instanceof Error ? error.name : "unknown" });
    return fail("unavailable");
  }

  // 4. 削除（関連データは外部キーの連鎖削除で消える）
  try {
    const outcome = await deps.deleteUser(user.id);
    deps.log?.(outcome === "deleted" ? "deleted" : "already-deleted", { userId: user.id });
  } catch (error) {
    deps.log?.("delete-failed", { userId: user.id, kind: error instanceof Error ? error.name : "unknown" });
    return fail("failed");
  }

  // 5. ログイン状態を破棄する（失敗しても、アカウントはすでに無いので、成功として扱う）
  try {
    await deps.signOut();
  } catch {
    /* ignore */
  }
  return { status: "deleted" };
}
