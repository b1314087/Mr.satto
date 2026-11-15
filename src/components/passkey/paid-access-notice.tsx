import Link from "next/link";
import { PAID_ACCESS_MESSAGE, type PaidAccessStatus } from "@/lib/passkey/policy";

/**
 * 有料の契約があるのに、パスキーの本人確認・端末の登録・同時利用の条件を満たしていない人への案内。
 * 「料金プランを見る」（申し込みの案内）ではなく、本人確認のページへ案内する。
 */
export function paidAccessMessage(status: PaidAccessStatus): string | null {
  if (status === "ok" || status === "not_paid" || status === "disabled") return null;
  return PAID_ACCESS_MESSAGE[status];
}

export function PaidAccessNotice({
  status,
  variant = "banner",
  next,
}: {
  status: PaidAccessStatus;
  variant?: "banner" | "card";
  /** 本人確認のあとに戻るページ */
  next?: string;
}) {
  const message = paidAccessMessage(status);
  if (!message) return null;
  const href = next ? `/account/security?next=${encodeURIComponent(next)}` : "/account/security";
  const action = status === "needs_passkey" ? "パスキーを登録する" : status === "unavailable" ? "ご利用状況を見る" : "パスキーで本人確認する";
  if (variant === "card") {
    return (
      <div
        data-testid="paid-access-notice"
        data-status={status}
        className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-blue-300 bg-blue-50 px-6 py-12 text-center dark:border-blue-800 dark:bg-blue-950/30"
      >
        <span className="rounded-full bg-blue-600 px-3 py-1 text-xs font-semibold text-white">本人確認が必要です</span>
        <p className="max-w-md text-sm leading-relaxed text-neutral-700 dark:text-neutral-200">{message}</p>
        <Link href={href} className="ms-btn ms-btn-primary">
          {action}
        </Link>
      </div>
    );
  }
  return (
    <div
      role="status"
      data-testid="paid-access-notice"
      data-status={status}
      className="mb-4 flex flex-col gap-2 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm text-blue-900 sm:flex-row sm:items-center sm:justify-between dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100"
    >
      <p className="leading-relaxed">{message}</p>
      <Link href={href} className="ms-btn ms-btn-primary shrink-0 self-start sm:self-auto">
        {action}
      </Link>
    </div>
  );
}
