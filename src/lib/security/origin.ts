/**
 * ブラウザからのPOSTリクエストの「送信元（Origin）」の確認（工程39）。純粋な判定で、通信はしない。
 *
 * 目的: ログイン中の利用者のブラウザを使って、他のサイトから決済・契約管理のAPIを呼ばせる（CSRF）のを防ぐ。
 * 許可する送信元は、サーバー側の設定（NEXT_PUBLIC_SITE_URL → siteConfig.url）だけを基準にする。
 * リクエストの Host ヘッダー、その他クライアントが指定できる値は、許可の根拠にしない。
 *
 * 判定:
 *  - Origin ヘッダーがある: 許可リストに完全一致するときだけ許可（"null"・不正な値・外部のサイトは拒否）。
 *  - Origin が無い: ブラウザが付ける Sec-Fetch-Site が same-origin のときだけ許可。それも無ければ拒否。
 *    （ブラウザのfetchによるPOSTは、通常 Origin を必ず付ける。Origin も Sec-Fetch-Site も無いのは、ブラウザ以外の呼び出し）
 *  - 開発・テスト（本番以外）では、localhost / 127.0.0.1 の送信元も許可する（本番では許可しない）。
 *
 * 対象は、ブラウザの画面から呼ぶPOST（決済ページの作成・契約管理ページの作成）。
 * Stripe Webhook は、Stripeのサーバーからの通知（署名で検証する）で、Origin を持たないため、対象にしない。
 */
export interface AllowedOrigins {
  /** 許可する送信元（"https://example.com" の形。末尾のスラッシュ・パスなし） */
  exact: readonly string[];
  /** localhost / 127.0.0.1 / [::1]（http）を許可するか（開発・テストのみ true） */
  allowLocalhost: boolean;
}

export type OriginDecision = { ok: true } | { ok: false; reason: "missing" | "invalid" | "foreign" };

/** サイトURL（設定値）から、許可する送信元を作る。www の有無だけ違う同じドメインも許可する */
export function allowedOriginsFor(siteUrl: string, nodeEnv: string | undefined): AllowedOrigins {
  const exact = new Set<string>();
  try {
    const parsed = new URL(siteUrl);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      exact.add(parsed.origin);
      const host = parsed.hostname;
      const isIpOrLocal = host === "localhost" || host.endsWith(".localhost") || /^[\d.]+$/.test(host) || host.includes(":");
      if (!isIpOrLocal && host.includes(".")) {
        const other = host.startsWith("www.") ? host.slice(4) : `www.${host}`;
        const variant = new URL(parsed.origin);
        variant.hostname = other;
        exact.add(variant.origin);
      }
    }
  } catch {
    // 不正な設定値なら、許可する送信元なし（すべて拒否）
  }
  return { exact: [...exact], allowLocalhost: nodeEnv !== "production" };
}

function isLocalhostOrigin(parsed: URL): boolean {
  if (parsed.protocol !== "http:") return false;
  return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
}

export function checkRequestOrigin(
  input: { origin: string | null; secFetchSite: string | null },
  allowed: AllowedOrigins,
): OriginDecision {
  const origin = input.origin?.trim() ?? "";
  if (origin === "") {
    // Origin が無い場合は、ブラウザ自身が「同じ送信元」と申告した場合だけ許可する
    return input.secFetchSite?.trim().toLowerCase() === "same-origin" ? { ok: true } : { ok: false, reason: "missing" };
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, reason: "invalid" };
  // 正規化した送信元（パス・認証情報つきの値などを、そのまま信用しない）
  if (origin !== parsed.origin) return { ok: false, reason: "invalid" };
  if (allowed.exact.includes(parsed.origin)) return { ok: true };
  if (allowed.allowLocalhost && isLocalhostOrigin(parsed)) return { ok: true };
  return { ok: false, reason: "foreign" };
}
