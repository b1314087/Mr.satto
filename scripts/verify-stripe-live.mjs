#!/usr/bin/env node
/**
 * 本番のStripeの設定が、Mr.Sattoの実装と食い違っていないかを確認する。読み取り専用（GETだけ。何も変更しない）。
 *
 * 確認する項目:
 *   1. キーが本番(live)か（テストキーとの取り違え）
 *   2. Premiumの価格(STRIPE_PREMIUM_PRICE_ID): 有効・円・1,100円・月次・税込
 *   3. Webhookのエンドポイント: https://mrsatto.com/api/stripe/webhook・有効・必要なイベントの購読
 *   4. Customer Portal: Mr.Satto専用の設定（解約=期間終了時・プラン変更=無効）と、そのID
 *   5. 契約の状態: 状態ごとの件数と、現行の価格以外（旧980円など）の契約の有無
 *
 * 出力に、メールアドレス・顧客ID・キーは含まれない（件数と、価格・Webhook・ポータルの設定だけ）。
 *
 * 使い方（Macのターミナルで。キーはチャットに貼らない。画面にも表示されない）:
 *   cd ~/Desktop/Mr-Satto
 *   read -s STRIPE_SECRET_KEY            # ← 読み取り専用の制限付きキー rk_live_… を貼って Enter
 *   export STRIPE_SECRET_KEY
 *   export STRIPE_PREMIUM_PRICE_ID=price_xxx   # Vercelに設定している値（秘密ではない）
 *   node scripts/verify-stripe-live.mjs
 *   unset STRIPE_SECRET_KEY
 *
 * 制限付きキーに必要な権限（すべて「読み取り」）: Prices, Products, Webhook Endpoints, Customer Portal, Subscriptions。
 * 権限が足りない項目は「確認できず」と表示され、ほかの項目の確認は続く。
 */

const key = (process.env.STRIPE_SECRET_KEY ?? "").trim();
const priceId = (process.env.STRIPE_PREMIUM_PRICE_ID ?? "").trim();
if (!/^(sk|rk)_(live|test)_/.test(key)) {
  console.error("STRIPE_SECRET_KEY が未設定、または形式が違います（sk_/rk_ で始まるキーを環境変数に入れてください）。");
  process.exit(1);
}
if (!/^price_/.test(priceId)) {
  console.error("STRIPE_PREMIUM_PRICE_ID が未設定、または形式が違います（price_ で始まるIDを環境変数に入れてください）。");
  process.exit(1);
}

// テスト用の接続先の上書きは、自分のPC(localhost)のときだけ許可する（キーを別のサーバーへ送らないため）
const BASE_OVERRIDE = process.env.STRIPE_API_BASE_FOR_TESTS;
if (BASE_OVERRIDE && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(BASE_OVERRIDE)) {
  console.error("STRIPE_API_BASE_FOR_TESTS は http://localhost または http://127.0.0.1 のときだけ使えます。");
  process.exit(1);
}
const BASE = BASE_OVERRIDE ?? "https://api.stripe.com/v1";
const SITE = "https://mrsatto.com";
const EXPECTED_YEN = 1100;
const REQUIRED_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

let problems = 0;
const ok = (msg) => console.log(`  [OK]   ${msg}`);
const ng = (msg) => {
  problems += 1;
  console.log(`  [要対応] ${msg}`);
};
const unknown = (msg) => console.log(`  [確認できず] ${msg}`);

async function get(path) {
  const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${key}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { error: `HTTP ${res.status}${body?.error?.message ? `（${body.error.message}）` : ""}` };
  return { body };
}

console.log(`キーの種類: ${key.startsWith("sk_live") || key.startsWith("rk_live") ? "本番(live)" : "テスト(test) ← 本番の確認には本番のキーが必要です"}`);
if (/_test_/.test(key)) problems += 1;

// 2. 価格
console.log("\n■ Premiumの価格");
{
  const r = await get(`/prices/${encodeURIComponent(priceId)}`);
  if (r.error) unknown(`価格を取得できません: ${r.error}`);
  else {
    const p = r.body;
    if (p.livemode) ok("本番の価格です");
    else ng("テスト用の価格です（本番のキーと一致していません）");
    if (p.active) ok("有効");
    else ng("無効（active=false）");
    if ((p.currency ?? "").toLowerCase() === "jpy") ok("通貨: 円");
    else ng(`通貨が円ではありません（${p.currency}）`);
    if (p.unit_amount === EXPECTED_YEN) ok(`金額: ${EXPECTED_YEN}円`);
    else ng(`金額が違います（${p.unit_amount}）`);
    const rec = p.recurring;
    if (rec && rec.interval === "month" && (rec.interval_count ?? 1) === 1 && (rec.usage_type ?? "licensed") === "licensed") ok("毎月の定額課金");
    else ng("毎月の定額課金ではありません");
    if (p.tax_behavior === "inclusive") ok("税込（tax_behavior=inclusive）");
    else console.log(`  [注意] tax_behavior=${p.tax_behavior ?? "未設定"}（「税込1,100円」の表示と、Stripeでの税の扱いが一致しているか、管理画面で確認してください）`);
    console.log(`  （商品ID: ${typeof p.product === "string" ? p.product : p.product?.id}）`);
  }
}

// 3. Webhook
console.log("\n■ Webhookのエンドポイント");
{
  const r = await get("/webhook_endpoints?limit=100");
  if (r.error) unknown(`取得できません: ${r.error}`);
  else {
    const mine = (r.body.data ?? []).filter((e) => (e.url ?? "").startsWith(SITE));
    if (mine.length === 0) ng(`${SITE} 宛てのエンドポイントがありません（登録済みのURL: ${(r.body.data ?? []).map((e) => e.url).join(", ") || "なし"}）`);
    for (const e of mine) {
      console.log(`  ${e.url}`);
      if (e.url === `${SITE}/api/stripe/webhook`) ok("URLは /api/stripe/webhook");
      else ng("URLが /api/stripe/webhook ではありません");
      if (e.status === "enabled") ok("有効");
      else ng(`状態が有効ではありません（${e.status}）`);
      if (e.livemode) ok("本番");
      else ng("テスト用のエンドポイントです");
      const events = e.enabled_events ?? [];
      const missing = events.includes("*") ? [] : REQUIRED_EVENTS.filter((ev) => !events.includes(ev));
      if (missing.length === 0) ok("必要なイベントをすべて購読している");
      else ng(`購読していないイベント: ${missing.join(", ")}`);
    }
  }
}

// 4. Portal
console.log("\n■ Customer Portal");
{
  const r = await get("/billing_portal/configurations?limit=100");
  if (r.error) unknown(`取得できません: ${r.error}`);
  else {
    const list = r.body.data ?? [];
    const mine = list.find((c) => c?.metadata?.app === "mr-satto" && c.active !== false);
    if (!mine) ng("Mr.Satto専用のポータル設定（metadata.app=mr-satto）がありません。scripts/create-portal-config.mjs で作成してください");
    else {
      ok(`Mr.Satto専用の設定があります（ID: ${mine.id}）→ Vercelの STRIPE_PORTAL_CONFIGURATION_ID と一致しているか確認してください`);
      if (mine.livemode) ok("本番");
      else ng("テスト用の設定です");
      if (mine.features?.subscription_update?.enabled === false) ok("プラン変更: 無効");
      else ng("プラン変更が有効です（無効にしてください）");
      if (mine.features?.subscription_cancel?.enabled && mine.features.subscription_cancel.mode === "at_period_end") ok("解約: 期間の終了時");
      else ng("解約の設定が「期間の終了時」ではありません");
      if (mine.default_return_url === `${SITE}/account`) ok(`戻り先: ${SITE}/account`);
      else console.log(`  [注意] 戻り先: ${mine.default_return_url ?? "未設定"}`);
    }
    const def = list.find((c) => c.is_default);
    if (def) console.log(`  （アカウントの既定の設定: プラン変更=${def.features?.subscription_update?.enabled ? "有効" : "無効"}。専用の設定IDを指定している間は使われません）`);
  }
}

// 5. 契約
console.log("\n■ 契約の状態（件数のみ。個人情報は出しません）");
{
  const r = await get("/subscriptions?status=all&limit=100");
  if (r.error) unknown(`取得できません: ${r.error}`);
  else {
    const byStatus = {};
    const otherPrices = {};
    for (const s of r.body.data ?? []) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
      for (const it of s.items?.data ?? []) {
        const id = it.price?.id;
        if (id && id !== priceId && ["active", "trialing", "past_due"].includes(s.status)) {
          const label = `${id}（${it.price?.unit_amount ?? "?"}${(it.price?.currency ?? "").toUpperCase()}）`;
          otherPrices[label] = (otherPrices[label] ?? 0) + 1;
        }
      }
    }
    console.log(`  状態ごとの件数: ${JSON.stringify(byStatus)}${r.body.has_more ? "（100件を超えるため一部）" : ""}`);
    const labels = Object.keys(otherPrices);
    if (labels.length === 0) ok("現行の価格以外で続いている契約はありません");
    else {
      for (const l of labels) console.log(`  [要確認] 現行以外の価格で続いている契約: ${l} × ${otherPrices[l]}件`);
      console.log("   → その契約者にPremiumを残すなら、その価格IDを Vercel の STRIPE_PREMIUM_LEGACY_PRICE_IDS に登録してください（登録がないと、無料扱いになります）。");
    }
  }
}

console.log(`\n結果: ${problems === 0 ? "要対応の項目はありません" : `要対応 ${problems} 件`}（「確認できず」は権限不足などで、判定していません）`);
process.exit(problems === 0 ? 0 : 2);
