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
  terms: "2026-10-29",
  privacy: "2026-10-30",
} as const;

export type LegalDocument = keyof typeof LEGAL_VERSIONS;

export const LEGAL_DOCUMENTS = Object.keys(LEGAL_VERSIONS) as LegalDocument[];

/** "2026-10-28" → "2026年10月28日"（表示用。形式が違えば、そのまま返す） */
export function formatLegalVersion(version: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
  if (!m) return version;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}
