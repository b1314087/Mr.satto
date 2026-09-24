import "server-only";

import Stripe from "stripe";
import { stripeConfig, isStripeConfigured } from "./config";

/**
 * サーバー専用のStripe SDKクライアント（遅延初期化）。
 *
 * モジュール読み込み時（import時）に `new Stripe()` を実行すると、
 * STRIPE_SECRET_KEY 未設定の環境（開発環境・このセッションの検証環境を含む）で
 * importするだけでエラーになり、ビルド自体が壊れてしまう。
 * そのため実際に呼び出された時点でのみ初期化し、未設定の場合は
 * 分かりやすい日本語エラーを投げる（Stripe機能を使わないページの
 * ビルド・表示には一切影響しない）。
 *
 * apiVersionは明示的に固定しない（SDKにバンドルされた既定値を使う）。
 * 実在しないバージョン文字列を推測で埋め込むことは行わない。
 */
let cachedClient: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!isStripeConfigured()) {
    throw new Error(
      "Stripeが設定されていません（STRIPE_SECRET_KEY未設定）。課金機能を有効にするには、" +
        "Stripeダッシュボードで取得したシークレットキーを環境変数へ設定してください。"
    );
  }
  if (!cachedClient) {
    cachedClient = new Stripe(stripeConfig.secretKey);
  }
  return cachedClient;
}
