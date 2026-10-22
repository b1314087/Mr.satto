#!/usr/bin/env node
/**
 * Mr.Satto専用の Stripe Customer Portal（解約・支払い方法の変更）の設定を作る。1回だけ実行する。
 *
 * なぜ必要か:
 *   StripeアカウントをUr SECONDなど他のサービスと共有していると、設定を指定しないポータルは、
 *   アカウントの「既定のポータル設定」を使う。それを避けるため、Mr.Satto専用の設定を別に作り、
 *   そのID（bpc_…）を Vercel の環境変数 STRIPE_PORTAL_CONFIGURATION_ID に入れる。
 *   既存の設定（既定の設定を含む）は変更しない。
 *
 * 作る設定（利用規約の第5条と一致させている）:
 *   - 解約: 有効。「契約期間の終了時」に解約される（解約後も期間の終了までは使える）
 *   - 支払い方法の変更・請求履歴: 有効
 *   - プランの変更（subscription_update）・顧客情報の更新: 無効（Mr.SattoのプランはPremium1つだけ）
 *
 * 使い方（Macのターミナルで。キーはチャットに貼らない。画面にも表示されない）:
 *   cd ~/Desktop/Mr-Satto
 *   read -s STRIPE_SECRET_KEY   # ← 制限付きキー rk_live_… を貼って Enter（入力は表示されない）
 *   export STRIPE_SECRET_KEY
 *   node scripts/create-portal-config.mjs
 *   unset STRIPE_SECRET_KEY
 *
 * 必要な権限: 「Customer Portal（カスタマーポータル）」の書き込み。
 * すでに同じ印（metadata.app=mr-satto）の設定があれば、新しく作らずに、そのIDを表示する。
 */

const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
if (!/^(sk|rk)_(live|test)_/.test(key)) {
  console.error("STRIPE_SECRET_KEY が未設定、または形式が違います（sk_/rk_ で始まるキーを環境変数に入れてください）。");
  process.exit(1);
}

const API = "https://api.stripe.com/v1/billing_portal/configurations";
const SITE = "https://mrsatto.com";

async function stripe(method, path, form) {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 本文（キーや個人情報は含まれない）のうち、原因の説明だけを表示する
    console.error(`Stripe APIがエラーを返しました（HTTP ${res.status}）: ${body?.error?.message ?? "不明なエラー"}`);
    process.exit(1);
  }
  return body;
}

const existing = await stripe("GET", "?limit=100");
const mine = (existing.data ?? []).find((c) => c?.metadata?.app === "mr-satto" && c.active !== false);
if (mine) {
  console.log(`すでにMr.Satto専用の設定があります（新しくは作りません）: ${mine.id}  (livemode=${mine.livemode})`);
  console.log("このIDを、Vercelの環境変数 STRIPE_PORTAL_CONFIGURATION_ID（Production）に設定してください。");
  process.exit(0);
}

const created = await stripe("POST", "", {
  "business_profile[headline]": "Mr.Satto Premium のご契約の管理",
  "business_profile[privacy_policy_url]": `${SITE}/privacy`,
  "business_profile[terms_of_service_url]": `${SITE}/terms`,
  default_return_url: `${SITE}/account`,
  "features[invoice_history][enabled]": "true",
  "features[payment_method_update][enabled]": "true",
  "features[customer_update][enabled]": "false",
  "features[subscription_update][enabled]": "false",
  "features[subscription_cancel][enabled]": "true",
  "features[subscription_cancel][mode]": "at_period_end",
  "features[subscription_cancel][proration_behavior]": "none",
  "features[subscription_cancel][cancellation_reason][enabled]": "true",
  "features[subscription_cancel][cancellation_reason][options][0]": "too_expensive",
  "features[subscription_cancel][cancellation_reason][options][1]": "missing_features",
  "features[subscription_cancel][cancellation_reason][options][2]": "unused",
  "features[subscription_cancel][cancellation_reason][options][3]": "other",
  "metadata[app]": "mr-satto",
});

console.log(`Mr.Satto専用のポータル設定を作りました: ${created.id}  (livemode=${created.livemode})`);
console.log("このIDを、Vercelの環境変数 STRIPE_PORTAL_CONFIGURATION_ID（Production）に設定してください。");
