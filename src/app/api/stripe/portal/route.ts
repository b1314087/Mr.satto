import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/user";
import { getStripeClient } from "@/lib/stripe/client";
import { isStripeConfigured } from "@/lib/stripe/config";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { siteConfig } from "@/lib/config/site";

/**
 * Stripe Customer Portal のセッションを作成し、そのURLを返す。
 * /account の「お支払い方法の変更・解約」導線から呼ばれる。
 *
 * 自前で複雑なカード管理・プラン変更画面を作らず、Stripeが提供する
 * Customer Portal（解約・プラン変更・支払い方法変更・請求履歴）に一任する
 * （Phase 3 spec 13章・14章）。
 */
export async function POST() {
  if (!isStripeConfigured()) {
    return NextResponse.json(
      { error: "現在、決済管理機能は準備中です（Stripeが設定されていません）。" },
      { status: 503 }
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "この操作にはログインが必要です。" }, { status: 401 });
  }

  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    return NextResponse.json(
      { error: "契約情報の取得に失敗しました。しばらくしてから再度お試しください。" },
      { status: 503 }
    );
  }

  const { data } = await supabase
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data?.stripe_customer_id) {
    return NextResponse.json(
      { error: "契約情報が見つかりません。まずプランへの登録を行ってください。" },
      { status: 404 }
    );
  }

  try {
    const stripe = getStripeClient();
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: data.stripe_customer_id,
      return_url: `${siteConfig.url}/account`,
    });
    return NextResponse.json({ url: portalSession.url });
  } catch (error) {
    console.error("[stripe/portal]", error);
    return NextResponse.json(
      { error: "契約管理ページの作成に失敗しました。しばらくしてから再度お試しください。" },
      { status: 502 }
    );
  }
}
