import { featureFlags } from "@/lib/config/features";
import { adConfig } from "@/lib/ads/config";

/**
 * 利用規約・プライバシーポリシーの「現行の版」（工程38）。
 *
 * 会員登録時・アカウント画面での同意は、ここの版を、同意の日時とともにサーバーへ記録する
 * （src/lib/legal/consent.ts、supabase/migrations/0004_terms_consents.sql）。
 * 画面に表示する「最終更新日」も、この値から作る（版と表示がずれないように）。
 *
 * ★規約・ポリシーの内容を変えたときは、該当する版の日付（YYYY-MM-DD）を、その日に更新する。
 *   版を更新すると、現行の版に同意した記録がないユーザーは、次に有料プランへ申し込むとき、あらためて同意を求められる
 *   （すでに契約中の方の利用は止まらない）。
 */
export const LEGAL_VERSIONS = {
  // 2026-11-15：AIの補助の追加（Word→Excel・見積書等のメモ）、年額プランの追加
  terms: "2026-11-15",
  // 2026-11-17：有料プランの本人確認（パスキー）・登録端末・同時利用の記載を追加（機能スイッチをオンにした日）。
  // この記載は、その仕組みの機能スイッチ（featureFlags.passkey）をオンにしたときから表示するので、版もそのときに上がる
  // 2026-11-27：AdSenseの発行者IDを設定している間は、広告配信事業者のCookieの扱いと止め方を記載（src/app/privacy/page.tsx）
  privacy: adConfig.adsenseClientId ? "2026-11-27" : featureFlags.passkey ? "2026-11-17" : "2026-11-15",
} as const;

export type LegalDocument = keyof typeof LEGAL_VERSIONS;

export const LEGAL_DOCUMENTS = Object.keys(LEGAL_VERSIONS) as LegalDocument[];

/** "2026-10-28" → "2026年10月28日"（表示用。形式が違えば、そのまま返す） */
export function formatLegalVersion(version: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
  if (!m) return version;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}
