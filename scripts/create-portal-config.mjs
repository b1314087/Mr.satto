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
 *   - 顧客情報の更新: 無効
 *   - プランの変更（subscription_update）: 2026-11 から、スタンダード（月220円）↔ プレミアム（月1,100円）の変更を有効にする
 *       スタンダード → プレミアム: すぐに切り替わり、差額は日割りでその場で請求（proration_behavior=always_invoice）
 *       プレミアム → スタンダード: 次回の更新日から切り替わる（schedule_at_period_end: 金額が下がる変更）
 *     環境変数 STRIPE_STANDARD_PRICE_ID と STRIPE_PREMIUM_PRICE_ID（どちらも price_… 。秘密の値ではない）を
 *     両方入れて実行したときだけ有効にする。片方でも無いときは、これまでどおり無効のまま。
 *     有効にしたあと、Vercelの環境変数 STRIPE_PLAN_CHANGE_ENABLED を true にすると、サイトにプラン変更のボタンが出る。
 *
 * すでにMr.Satto専用の設定（metadata.app=mr-satto）があるときは、新しく作らず、その設定のプラン変更の部分だけを更新する。
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

const API_ROOT = "https://api.stripe.com/v1";
const API = `${API_ROOT}/billing_portal/configurations`;
const SITE = "https://mrsatto.com";

async function stripe(method, path, form, root = API) {
  const res = await fetch(root + path, {
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

// プラン変更（スタンダード ↔ プレミアム）の設定。両方の価格IDがあるときだけ有効にする
const standardPrice = (process.env.STRIPE_STANDARD_PRICE_ID ?? "").trim();
const premiumPrice = (process.env.STRIPE_PREMIUM_PRICE_ID ?? "").trim();
async function planChangeFields() {
  if (!/^price_/.test(standardPrice) || !/^price_/.test(premiumPrice)) {
    console.log("STRIPE_STANDARD_PRICE_ID / STRIPE_PREMIUM_PRICE_ID が両方そろっていないため、プラン変更は無効のままにします。");
    return { "features[subscription_update][enabled]": "false" };
  }
  const standard = await stripe("GET", `/prices/${encodeURIComponent(standardPrice)}`, undefined, API_ROOT);
  const premium = await stripe("GET", `/prices/${encodeURIComponent(premiumPrice)}`, undefined, API_ROOT);
  const ok = (p, yen) => p.currency === "jpy" && p.unit_amount === yen && p.recurring?.interval === "month" && p.active !== false;
  if (!ok(standard, 220) || !ok(premium, 1100)) {
    console.error("価格の内容が想定と違います（スタンダード=月220円・プレミアム=月1,100円、JPY・毎月・有効）。設定を見直してください。");
    process.exit(1);
  }
  const productOf = (p) => (typeof p.product === "string" ? p.product : p.product?.id);
  // 同じ商品の下に2つの価格がある場合も、ない場合も、それぞれの商品に、その価格を並べる
  const byProduct = new Map();
  for (const p of [standard, premium]) byProduct.set(productOf(p), [...(byProduct.get(productOf(p)) ?? []), p.id]);
  const fields = {
    "features[subscription_update][enabled]": "true",
    "features[subscription_update][default_allowed_updates][0]": "price",
    "features[subscription_update][proration_behavior]": "always_invoice",
    "features[subscription_update][schedule_at_period_end][conditions][0][type]": "decreasing_item_amount",
  };
  [...byProduct.entries()].forEach(([product, prices], i) => {
    fields[`features[subscription_update][products][${i}][product]`] = product;
    prices.forEach((price, j) => {
      fields[`features[subscription_update][products][${i}][prices][${j}]`] = price;
    });
  });
  console.log("プラン変更を有効にします（スタンダード→プレミアムはすぐに・差額は日割りで請求／プレミアム→スタンダードは次回の更新日から）。");
  return fields;
}

const existing = await stripe("GET", "?limit=100");
const mine = (existing.data ?? []).find((c) => c?.metadata?.app === "mr-satto" && c.active !== false);
if (mine) {
  const updated = await stripe("POST", `/${encodeURIComponent(mine.id)}`, await planChangeFields());
  console.log(`すでにあるMr.Satto専用の設定を更新しました（プラン変更の部分だけ）: ${updated.id}  (livemode=${updated.livemode})`);
  console.log("このIDが、Vercelの環境変数 STRIPE_PORTAL_CONFIGURATION_ID（Production）に設定されていることを確認してください。");
  process.exit(0);
}

const created = await stripe("POST", "", {
  "business_profile[headline]": "Mr.Satto のご契約の管理",
  "business_profile[privacy_policy_url]": `${SITE}/privacy`,
  "business_profile[terms_of_service_url]": `${SITE}/terms`,
  default_return_url: `${SITE}/account`,
  "features[invoice_history][enabled]": "true",
  "features[payment_method_update][enabled]": "true",
  "features[customer_update][enabled]": "false",
  ...(await planChangeFields()),
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
