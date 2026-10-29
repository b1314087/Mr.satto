import Link from "next/link";
import { startTrialAction } from "@/lib/plans/trial-actions";
import { GRANT_SOURCE_LABEL, TRIAL_DAYS, formatGrantEnd, type GrantSource, type TrialOfferState } from "@/lib/plans/grants";

/**
 * プレミアムの「3日間 無料お試し」の案内（料金プラン・アカウント画面で共通）。
 * お試しは、アカウントごとに1回だけ。自動で課金されることはなく、期限が来たら無料プランに戻る。
 */
export function TrialCard({
  state,
  grant,
}: {
  state: TrialOfferState;
  grant?: { source: GrantSource; endsAt: string } | null;
}) {
  if (state === "hidden") return null;

  if (state === "active" && grant) {
    return (
      <section className="ms-glass mb-6 px-4 py-3 text-sm text-ms-text" data-testid="trial-active" role="status">
        <p className="font-medium">
          プレミアムを無料でご利用中です（{GRANT_SOURCE_LABEL[grant.source]}）
        </p>
        <p className="mt-1 text-xs text-ms-muted">
          {formatGrantEnd(grant.endsAt)} まで。期限が来ると、自動で無料プランに戻ります（お支払いは発生しません）。
        </p>
      </section>
    );
  }

  return (
    <section className="ms-glass mb-6 flex flex-col gap-3 p-5" data-testid="trial-offer">
      <div>
        <h2 className="text-base font-semibold text-ms-text">プレミアムを{TRIAL_DAYS}日間、無料でためせます</h2>
        <p className="mt-1 text-xs leading-relaxed text-ms-muted">
          1アカウントにつき1回だけ。お支払い方法の登録は不要で、自動で課金されることはありません。期限が来ると、自動で無料プランに戻ります。
          AIの利用枠は、お試しの間は少なめです。
        </p>
      </div>
      {state === "available" ? (
        <form action={startTrialAction}>
          <button type="submit" className="ms-btn ms-btn-primary" data-testid="trial-start">
            {TRIAL_DAYS}日間、無料でためす
          </button>
        </form>
      ) : (
        <Link href="/signup" className="ms-btn ms-btn-primary w-fit" data-testid="trial-signup">
          会員登録して{TRIAL_DAYS}日間、無料でためす
        </Link>
      )}
    </section>
  );
}
