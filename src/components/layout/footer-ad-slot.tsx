"use client";

import { useEffect, useState } from "react";
import { AdSlot } from "@/components/ads/ad-slot";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { shouldShowAds } from "@/lib/plans/access";
import type { Plan } from "@/lib/plans/types";

/**
 * フッター広告の表示要否を判定してから <AdSlot placement="footer" /> を描画する
 * （Phase 23監査で発見・修正: Phase 20時点ではフッターに広告なしプランの判定が
 * 一切接続されておらず、Standard/Premiumユーザーにもフッター広告が表示され
 * 続ける状態だった）。
 *
 * フッターは src/app/layout.tsx（RootLayout）から描画され、ツール詳細ページ
 * （src/app/tools/[tool]/page.tsx）が getServerPlan() で確定させたサーバー側の
 * プランはコンポーネントツリー上の親兄弟であるRootLayout/Footerへは
 * 渡せない（Reactのprops/contextは祖先→子孫方向にしか流れず、Footerは
 * ページの子孫ではない）。これを解消するためにRootLayoutやFooter自体を
 * cookies()を読むサーバーコンポーネントへ変更すると、現在は静的生成できている
 * ページ（トップ/about/pricing等）までサイト全体がdynamic renderingへ
 * 強制的に変わってしまうため、今回はその大きな設計変更は行わない。
 *
 * 代わりに、src/lib/plans/plan-context.tsx と同じ「表示専用・判定不能な場合は
 * 安全側として広告を表示する」という方針を踏襲し、クライアント側で
 * Supabase（anon key。RLSの"select own"ポリシーにより本人の行のみ取得可能。
 * supabase/migrations/0001_billing_schema.sql参照）からベストエフォートで
 * 契約状態を取得し、Standard/Premiumの有効な契約が確認できた場合のみ
 * 広告を非表示にする。
 *
 * 重要: これは広告の見た目だけの判断であり、ツールの利用可否（アクセス制御）
 * には一切使わない。アクセス制御は引き続き必ずサーバー側の
 * getServerPlan()（src/lib/plans/current-plan.ts）だけを経由する
 * （src/lib/supabase/client.ts のコメントが警告している「プラン判定など
 * 信頼性が必要な処理」には該当しない）。
 *
 * トレードオフ: 初回表示時は契約状態が未確定のため一瞬広告が表示され、
 * 確認が取れ次第非表示に切り替わる（サーバー側で確定させるより弱い保証だが、
 * サイト全体の静的生成を諦めるより小さな副作用として許容する）。
 */
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

/**
 * 開発専用のプラン上書きCookie名（Phase 11由来）。
 * 本来の定義元は src/lib/plans/current-plan.ts の DEV_PLAN_OVERRIDE_COOKIE だが、
 * そちらは "server-only" ガード付きのモジュールでありクライアント
 * コンポーネントからimportできないため、名称をここに複製している
 * （tests/helpers/dev-plan.ts も同様の理由で文字列を直接使っている）。
 * 値を変更する場合は3箇所とも揃えて変更すること。
 */
const DEV_PLAN_OVERRIDE_COOKIE_NAME = "mrsatto-dev-plan-override";

function readDevPlanOverrideCookie(): Plan | null {
  // 本番ビルドではNODE_ENVがビルド時に"production"へ置換されるため、
  // このif文ごとデッドコードとして除去される(current-plan.tsのサーバー側
  // ガードと同じ考え方。開発専用の抜け道を本番へ持ち込まないため)。
  if (process.env.NODE_ENV !== "development") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${DEV_PLAN_OVERRIDE_COOKIE_NAME}=([^;]*)`));
  const value = match ? decodeURIComponent(match[1]) : null;
  return value === "free" || value === "standard" || value === "premium" ? value : null;
}

function useFooterShouldShowAds(): boolean {
  const [showAds, setShowAds] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      // 開発専用Cookie（本番ビルドではreadDevPlanOverrideCookie()自体がnullを返す）
      const devOverride = readDevPlanOverrideCookie();
      if (devOverride) {
        if (!cancelled) setShowAds(shouldShowAds(devOverride));
        return;
      }

      if (!isSupabaseConfigured()) return;
      const supabase = getSupabaseBrowserClient();
      if (!supabase) return;

      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;
      if (!user) return; // 未ログイン = free。デフォルトのtrue(広告あり)のまま。

      const { data } = await supabase
        .from("subscriptions")
        .select("plan, status")
        .eq("user_id", user.id)
        .maybeSingle();

      if (cancelled || !data?.plan || !data?.status) return;
      if (!ACTIVE_SUBSCRIPTION_STATUSES.has(data.status as string)) return;

      setShowAds(shouldShowAds(data.plan as Plan));
    }

    resolve();
    return () => {
      cancelled = true;
    };
  }, []);

  return showAds;
}

export function FooterAdSlot() {
  const showAds = useFooterShouldShowAds();
  if (!showAds) return null;
  return <AdSlot placement="footer" />;
}
