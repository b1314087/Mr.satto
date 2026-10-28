import { LEGAL_DOCUMENTS, LEGAL_VERSIONS, type LegalDocument } from "./versions";

/**
 * 利用規約・プライバシーポリシーへの同意の記録に関する純粋な判定（工程38）。
 * データベースへの読み書きは consent-store.ts（server-only）が行う。ここは通信を持たないので、単体テストできる。
 *
 * 記録する内容は最小限: ユーザーの識別子・文書の種類・版・日時（DB側で付与）・経路。
 * メールアドレス、IPアドレス、端末情報は記録しない。
 */

/** 同意をした経路。signup = 会員登録時 / account = アカウント画面での同意 */
export type ConsentSource = "signup" | "account";

export interface ConsentRecordLike {
  document: string;
  version: string;
}

export interface ConsentInsertRow {
  user_id: string;
  document: LegalDocument;
  version: string;
  source: ConsentSource;
}

/**
 * 現行の版に対する同意の記録が、まだ無い文書の一覧。
 * 古い版への同意は「現行の版への同意」にはならない（規約を改定したら、あらためて同意を求める）。
 */
export function missingConsents(
  records: readonly ConsentRecordLike[],
  versions: Record<LegalDocument, string> = LEGAL_VERSIONS,
): LegalDocument[] {
  return LEGAL_DOCUMENTS.filter((doc) => !records.some((r) => r.document === doc && r.version === versions[doc]));
}

export function hasAllCurrentConsents(
  records: readonly ConsentRecordLike[],
  versions: Record<LegalDocument, string> = LEGAL_VERSIONS,
): boolean {
  return missingConsents(records, versions).length === 0;
}

/**
 * 保存する行を作る。版は、クライアントから受け取らず、必ずサーバー側の現行の版（LEGAL_VERSIONS）を使う。
 * 日時（accepted_at）もサーバー（DB）の now() が付けるので、ここには含めない。
 */
export function buildConsentRows(
  userId: string,
  source: ConsentSource,
  versions: Record<LegalDocument, string> = LEGAL_VERSIONS,
): ConsentInsertRow[] {
  return LEGAL_DOCUMENTS.map((document) => ({ user_id: userId, document, version: versions[document], source }));
}

export const CONSENT_REQUIRED_MESSAGE =
  "有料プランのお申し込みには、現在の利用規約とプライバシーポリシーへの同意が必要です。アカウント画面で内容を確認し、同意してください。";
export const CONSENT_UNAVAILABLE_MESSAGE =
  "現在、お申し込みの受け付けを準備中です。しばらくしてから、もう一度お試しください。";
