/**
 * 帳票共通データモデル（Phase 2-C: Premium文書作成ツール）。
 *
 * Document
 *  ↓
 * DocumentType ("estimate" | "invoice" | "order")
 *  ↓
 * 共通フォーム（DocumentBasicForm / PartyInfoForm / LineItemsEditor / TaxSettings）
 *  ↓
 * 共通帳票プレビュー（DocumentPreview）
 *  ↓
 * PDF生成（DocumentPdfProcessor）
 *  ↓
 * ダウンロード（RewardedDownloadGate）
 *
 * 将来「納品書」「領収書」「発注書」などを追加する際は、この
 * DocumentType の union に値を増やし、DOCUMENT_TYPE_META に
 * 表示文言を追加するだけで、フォーム・プレビュー・PDF生成の
 * 大部分をそのまま再利用できることを目指す（過剰な抽象化はしない）。
 */

export type DocumentType = "estimate" | "invoice" | "order";

/** 消費税率。0%も選択できるようにする */
export type TaxRatePercent = 0 | 8 | 10;

export const TAX_RATE_OPTIONS: TaxRatePercent[] = [10, 8, 0];

/** 端数処理方式。共通設定として持ち、基本値は「切り捨て」 */
export type TaxRounding = "floor" | "round" | "ceil";

export const DEFAULT_TAX_ROUNDING: TaxRounding = "floor";

export const TAX_ROUNDING_LABELS: Record<TaxRounding, string> = {
  floor: "切り捨て",
  round: "四捨五入",
  ceil: "切り上げ",
};

/** 発行者・宛先で共通して使う項目 */
export interface PartyInfo {
  companyName: string;
  contactName: string;
  postalCode: string;
  address: string;
  tel: string;
  email: string;
}

export function createEmptyParty(): PartyInfo {
  return { companyName: "", contactName: "", postalCode: "", address: "", tel: "", email: "" };
}

/** そのPartyInfoが実質的に何も入力されていないか（バリデーション用） */
export function isPartyEmpty(party: PartyInfo): boolean {
  return Object.values(party).every((v) => v.trim() === "");
}

/**
 * 明細行の入力値（UIのコントロール入力に対応するため、数量・単価は
 * 文字列として保持する。計算時に parseLineItem() で数値へ変換する）。
 */
export interface LineItemInput {
  id: string;
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
}

export function createEmptyLineItem(id: string): LineItemInput {
  return { id, name: "", quantity: "1", unit: "式", unitPrice: "" };
}

/** 計算・PDF生成で使う、数値へ変換済みの明細行 */
export interface ParsedLineItem {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  unitPrice: number;
  /** quantity × unitPrice（整数円） */
  amount: number;
}

/** 請求書の振込先情報 */
export interface BankAccountInfo {
  bankName: string;
  branchName: string;
  accountType: string;
  accountNumber: string;
  accountHolder: string;
}

export function createEmptyBankAccount(): BankAccountInfo {
  return { bankName: "", branchName: "", accountType: "普通", accountNumber: "", accountHolder: "" };
}

export function isBankAccountEmpty(bank: BankAccountInfo): boolean {
  return Object.values(bank).every((v) => v.trim() === "" || v === "普通");
}

/** 3帳票共通のフォーム状態 */
export interface DocumentFormState {
  type: DocumentType;
  documentNumber: string;
  issueDate: string;
  title: string;
  /** 見積書=有効期限 / 請求書=支払期限 / 注文書=納期 */
  secondaryDate: string;
  issuer: PartyInfo;
  recipient: PartyInfo;
  items: LineItemInput[];
  taxRatePercent: TaxRatePercent;
  taxRounding: TaxRounding;
  notes: string;
  /** 請求書のみ使用 */
  bankAccount: BankAccountInfo;
}

export interface DocumentTypeMeta {
  id: DocumentType;
  /** ツール名・見出しに使う表示名 */
  label: string;
  /** 書類タイトルの初期値 */
  defaultTitle: string;
  /** 「有効期限」「支払期限」「納期」など、2つ目の日付項目のラベル */
  secondaryDateLabel: string;
  /** ファイル名の接頭辞（例: 見積書_2026-09-24.pdf） */
  fileNamePrefix: string;
  /** 振込先情報の入力欄を表示するか（請求書のみ） */
  showBankAccount: boolean;
  actionLabel: string;
}

export const DOCUMENT_TYPE_META: Record<DocumentType, DocumentTypeMeta> = {
  estimate: {
    id: "estimate",
    label: "見積書",
    defaultTitle: "見積書",
    secondaryDateLabel: "有効期限",
    fileNamePrefix: "見積書",
    showBankAccount: false,
    actionLabel: "見積書を作成する",
  },
  invoice: {
    id: "invoice",
    label: "請求書",
    defaultTitle: "請求書",
    secondaryDateLabel: "支払期限",
    fileNamePrefix: "請求書",
    showBankAccount: true,
    actionLabel: "請求書を作成する",
  },
  order: {
    id: "order",
    label: "注文書",
    defaultTitle: "注文書",
    secondaryDateLabel: "納期",
    fileNamePrefix: "注文書",
    showBankAccount: false,
    actionLabel: "注文書を作成する",
  },
};

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

let lineItemSeq = 0;
export function nextLineItemId(): string {
  lineItemSeq += 1;
  return `item-${Date.now()}-${lineItemSeq}`;
}

/**
 * 書類番号の自動採番（開発指示書■13）。
 * あくまで初期値の提案であり、ユーザーは自由に変更できる。
 * DBへの保存や重複防止などは行わない（今回実装しない機能）。
 */
export function generateDocumentNumber(type: DocumentType): string {
  const prefix = { estimate: "EST", invoice: "INV", order: "ORD" }[type];
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const rand = String(Math.floor(Math.random() * 900) + 100);
  return `${prefix}-${y}${m}${d}-${rand}`;
}

export function createEmptyDocumentForm(type: DocumentType): DocumentFormState {
  return {
    type,
    documentNumber: "",
    issueDate: todayIso(),
    title: DOCUMENT_TYPE_META[type].defaultTitle,
    secondaryDate: "",
    issuer: createEmptyParty(),
    recipient: createEmptyParty(),
    items: [createEmptyLineItem(nextLineItemId())],
    taxRatePercent: 10,
    taxRounding: DEFAULT_TAX_ROUNDING,
    notes: "",
    bankAccount: createEmptyBankAccount(),
  };
}
