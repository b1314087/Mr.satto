"use server";

import { redirect } from "next/navigation";
import { featureFlags } from "@/lib/config/features";
import { getServerPlan } from "./current-plan";
import { resolveEffectivePlan } from "./effective-plan";
import { startTrial } from "./grant-store";

/**
 * 「3日間、無料でためす」ボタンの処理（Server Action）。ログイン中の本人だけが、アカウントごとに1回だけ使える。
 * 結果は /account?trial=... へ戻って、メッセージで知らせる。課金（Stripe）には一切つながらない。
 */
export async function startTrialAction(): Promise<void> {
  if (!featureFlags.billing) redirect("/pricing");

  const ctx = await getServerPlan();
  if (!ctx.userId) redirect("/login?next=/pricing");

  // すでにStripeの契約でプレミアムの人には、始めさせない
  if (resolveEffectivePlan(ctx.subscription) === "premium") redirect("/account?trial=premium");

  const result = await startTrial(ctx.userId);
  if (result.ok) redirect("/account?trial=started");
  redirect(`/account?trial=${result.reason}`);
}
