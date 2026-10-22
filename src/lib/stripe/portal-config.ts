/**
 * Customer Portal の設定ID（STRIPE_PORTAL_CONFIGURATION_ID）の解釈。
 * 外部通信をしない純粋な関数（テストしやすいように、server-only の config.ts から分けている）。
 *
 * 方針:
 *   - 未設定（空）            : 従来どおり。Stripeアカウントの既定のポータル設定が使われる。
 *   - 正しい形式（bpc_…）     : その設定を明示的に使う（Mr.Satto専用の設定）。
 *   - 指定があるのに形式が違う : 誤設定。他サービスの既定設定へ黙って切り替えず、ポータルを開かない（安全側）。
 */

const PORTAL_CONFIGURATION_ID_PATTERN = /^bpc_[A-Za-z0-9]{8,}$/;

export type PortalConfiguration = { ok: true; id: string | undefined } | { ok: false };

export function resolvePortalConfiguration(raw: string | undefined | null): PortalConfiguration {
  const value = (raw ?? "").trim();
  if (value.length === 0) return { ok: true, id: undefined };
  return PORTAL_CONFIGURATION_ID_PATTERN.test(value) ? { ok: true, id: value } : { ok: false };
}
