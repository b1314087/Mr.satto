import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { resolvePortalConfiguration } from "@/lib/stripe/portal-config";

/**
 * Customer Portal の設定ID。外部通信なし（純粋な関数とソースの静的な確認だけ）。
 * 同じStripeアカウントを他サービスと共有していても、Mr.Satto専用の設定を使えること、
 * 未設定のときは従来どおり（既定の設定）で動くこと、設定ミスのときは黙って切り替えず止まることを確かめる。
 */
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

test.describe("設定IDの解釈（resolvePortalConfiguration）", () => {
  test("未設定・空・空白だけ: 従来どおり（IDなし）", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(resolvePortalConfiguration(raw)).toEqual({ ok: true, id: undefined });
    }
  });

  test("bpc_… の形式: そのIDを使う（前後の空白・改行は除く）", () => {
    expect(resolvePortalConfiguration("bpc_1AbCdEfGhIjKlMnO")).toEqual({ ok: true, id: "bpc_1AbCdEfGhIjKlMnO" });
    expect(resolvePortalConfiguration("  bpc_1AbCdEfGhIjKlMnO\n")).toEqual({ ok: true, id: "bpc_1AbCdEfGhIjKlMnO" });
  });

  test("指定があるのに形式が違う（秘密キー・価格ID・短すぎる・記号入り）は誤設定として扱う", () => {
    for (const raw of ["sk_live_abc12345", "price_1UTF6t6u4ognflrh", "bpc_", "bpc_short", "bpc_ab cdefghijkl", "BPC_1AbCdEfGhIjKl", "bpc_1AbCdEfGh;DROP"]) {
      expect(resolvePortalConfiguration(raw), raw).toEqual({ ok: false });
    }
  });
});

test.describe("ポータル作成の呼び出し（ソースの静的な確認）", () => {
  test("設定IDがあるときだけ configuration を渡し、誤設定は503で止める（他サービスの既定設定へ黙って切り替えない）", () => {
    const route = read("src/app/api/stripe/portal/route.ts");
    expect(route).toContain("resolvePortalConfiguration(stripeConfig.portalConfigurationId)");
    expect(route).toContain("portalConfiguration.id ? { configuration: portalConfiguration.id } : {}");
    expect(route).toMatch(/if \(!portalConfiguration\.ok\) \{[\s\S]*?status: 503/);
    // 設定IDそのものをログ・応答に出さない
    expect(route).not.toMatch(/console\.(log|error|warn)\([^)]*portalConfiguration\.id/);
  });

  test("設定IDは環境変数 STRIPE_PORTAL_CONFIGURATION_ID から読み、NEXT_PUBLIC_ を付けない", () => {
    expect(read("src/lib/stripe/config.ts")).toContain('trimmedEnv("STRIPE_PORTAL_CONFIGURATION_ID")');
    const example = read(".env.example");
    expect(example).toContain("STRIPE_PORTAL_CONFIGURATION_ID=");
    expect(example).not.toMatch(/NEXT_PUBLIC_[A-Z_]*PORTAL/);
  });
});

test.describe("専用設定の作成スクリプト（静的なレビュー。実行はしない）", () => {
  const script = read("scripts/create-portal-config.mjs");

  test("契約期間の終了時に解約（利用規約の第5条と一致）・支払い方法の変更・請求履歴は有効", () => {
    expect(script).toContain('"features[subscription_cancel][mode]": "at_period_end"');
    expect(script).toContain('"features[subscription_cancel][enabled]": "true"');
    expect(script).toContain('"features[payment_method_update][enabled]": "true"');
    expect(script).toContain('"features[invoice_history][enabled]": "true"');
  });

  test("プラン変更：両方の価格IDがあるときだけ有効。アップグレードはすぐ（日割りで請求）、ダウングレードは次回の更新日から", () => {
    // 価格IDがそろわないときは無効のまま
    expect(script).toContain('"features[subscription_update][enabled]": "false"');
    expect(script).toContain('"features[subscription_update][enabled]": "true"');
    expect(script).toContain("process.env.STRIPE_STANDARD_PRICE_ID");
    expect(script).toContain("process.env.STRIPE_PREMIUM_PRICE_ID");
    expect(script).toContain('"features[subscription_update][proration_behavior]": "always_invoice"');
    expect(script).toContain('"features[subscription_update][schedule_at_period_end][conditions][0][type]": "decreasing_item_amount"');
    // 価格の中身（月220円・月1,100円・JPY・毎月）を確かめてから有効にする
    expect(script).toMatch(/ok\(standard, 220\)/);
    expect(script).toMatch(/ok\(premium, 1100\)/);
  });

  test("変更するのは、Mr.Satto専用のポータル設定だけ（商品・価格・契約は読むだけで変更しない）", () => {
    const calls = [...script.matchAll(/stripe\(\s*"([A-Z]+)"\s*,\s*(["`])([^"`]*)\2/g)].map((m) => `${m[1]} ${m[3]}`);
    expect(calls.sort()).toEqual(
      ["GET ?limit=100", "POST ", "POST /${encodeURIComponent(mine.id)}", "GET /prices/${encodeURIComponent(standardPrice)}", "GET /prices/${encodeURIComponent(premiumPrice)}"].sort(),
    );
    expect(script).not.toMatch(/"(DELETE|PUT|PATCH)"/);
    // 価格は読むだけ（GET）。POST はポータル設定のエンドポイントだけ
    expect(script).toContain('`${API_ROOT}/billing_portal/configurations`');
    expect(script.match(/https:\/\/api\.stripe\.com/g)).toHaveLength(1);
  });

  test("すでにMr.Satto専用の設定（metadata.app=mr-satto）があれば、新しく作らず、その設定のプラン変更の部分だけを更新する", () => {
    expect(script).toContain('"metadata[app]": "mr-satto"');
    expect(script).toMatch(/c\?\.metadata\?\.app === "mr-satto"/);
    expect(script).toMatch(/process\.exit\(0\)/);
  });

  test("キーは環境変数からだけ読み、画面・ログに出さない。形式が違えば何も送らず終了する", () => {
    expect(script).toContain("process.env.STRIPE_SECRET_KEY");
    // key を含む出力（console.*）が無い
    for (const m of script.matchAll(/console\.(log|error)\(([^;]*)\);/g)) {
      expect(m[2], m[0]).not.toMatch(/\bkey\b|STRIPE_SECRET_KEY(?!\s*が)/);
    }
    expect(script).toMatch(/\^\(sk\|rk\)_\(live\|test\)_/);
  });

  test("エラー時は、Stripeの説明文だけを出す（リクエスト・認証ヘッダーは出さない）", () => {
    expect(script).toContain("body?.error?.message");
    expect(script).not.toMatch(/console\.(log|error)\([^)]*(authorization|headers)/i);
  });
});
