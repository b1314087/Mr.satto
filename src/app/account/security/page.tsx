import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getServerPlan } from "@/lib/plans/current-plan";
import { PLAN_DEFINITIONS } from "@/lib/plans/types";
import { featureFlags } from "@/lib/config/features";
import { isSafeInternalPath } from "@/lib/auth/safe-redirect";
import { getPasskeyUser, loadSecurityOverview } from "@/lib/passkey/server";
import { MAX_DEVICES } from "@/lib/passkey/config";
import { PasskeyManager } from "@/components/passkey/passkey-manager";

export const metadata: Metadata = {
  title: "パスキーと登録端末",
  description: "有料プランで使うパスキーと、登録した端末を管理します。",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/**
 * パスキーと登録端末の管理（有料プランの本人確認）。
 * - パスキーの登録（決済のあと・既存の有料会員）
 * - パスキーでの本人確認（新しい端末の登録・利用の開始・別の端末からの切り替え）
 * - 登録したパスキー・端末の一覧と解除（解除にはパスキーでの本人確認が必要）
 */
export default async function AccountSecurityPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!featureFlags.passkey) notFound();
  const { next } = await searchParams;
  const safeNext = typeof next === "string" && isSafeInternalPath(next) ? next : null;

  const [user, serverPlan] = await Promise.all([getPasskeyUser(), getServerPlan()]);
  if (!user || !serverPlan.userId) {
    return (
      <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
        <h1 className="mb-3 text-2xl font-bold text-ms-text">パスキーと登録端末</h1>
        <p className="mb-6 text-sm text-ms-muted">この画面を使うには、ログインが必要です。</p>
        <Link href="/login?next=/account/security" className="ms-btn ms-btn-primary">
          ログイン
        </Link>
      </div>
    );
  }

  const overview = await loadSecurityOverview(user.id);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-12 sm:px-6">
      <p className="mb-2 text-sm">
        <Link href="/account" className="text-ms-accent hover:underline dark:text-ms-focus">
          ← アカウント
        </Link>
      </p>
      <h1 className="mb-2 text-2xl font-bold text-ms-text">パスキーと登録端末</h1>
      <p className="mb-6 text-sm leading-relaxed text-ms-muted">
        有料プラン（{PLAN_DEFINITIONS.standard.name}・{PLAN_DEFINITIONS.premium.name}）は、パスキーでの本人確認と、登録した端末（最大{MAX_DEVICES}台）でご利用いただけます。同時に使えるのは1台です。
        パスキーは、Apple（iCloudキーチェーン）・Google（Googleパスワードマネージャー）・Microsoft（Windows Hello）で作れます。
      </p>
      {overview ? (
        <PasskeyManager
          status={serverPlan.paidAccess}
          contractPaid={serverPlan.contractPlan !== "free"}
          credentials={overview.credentials}
          devices={overview.devices}
          next={safeNext}
        />
      ) : (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          現在、パスキーの情報を読み込めません。しばらくしてから、もう一度お試しください。
        </p>
      )}
    </div>
  );
}
