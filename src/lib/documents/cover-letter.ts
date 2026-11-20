/**
 * 送付状（書類送付状・FAX送付状）の入力と、文面の組み立て（2026-11-20）。
 *
 * - 書類を郵送・手渡しするときの「書類送付状」と、FAXで送るときの「FAX送付状」の2種類。
 * - 宛名の敬称は、担当者名があれば「様」、会社名・部署だけなら「御中」を自動で付ける（「御中」と「様」は重ねない）。
 * - あいさつ文は、ひな形を入れておき、利用者が自由に書き換えられる。
 * - 画面のプレビューとPDFは、どちらもこのファイルの関数で文面を組み立てる（表示の食い違いを防ぐ）。
 */

export type CoverLetterKind = "document" | "fax";

export interface CoverLetterRecipient {
  companyName: string;
  department: string;
  contactName: string;
  /** FAX送付状のときだけ使う */
  fax: string;
  tel: string;
}

export interface CoverLetterSender {
  companyName: string;
  department: string;
  contactName: string;
  postalCode: string;
  address: string;
  tel: string;
  fax: string;
  email: string;
}

export interface CoverLetterItem {
  id: string;
  name: string;
  /** 部数（文字のまま持つ。空なら部数を書かない） */
  copies: string;
}

export interface CoverLetterForm {
  kind: CoverLetterKind;
  /** 日付（YYYY-MM-DD） */
  date: string;
  /** 件名（空なら種類ごとの見出し） */
  subject: string;
  recipient: CoverLetterRecipient;
  sender: CoverLetterSender;
  /** あいさつ文（拝啓〜敬具まで。空なら書かない） */
  greeting: string;
  items: CoverLetterItem[];
  /** FAXの送信枚数（本紙を含む。FAX送付状のときだけ） */
  faxPages: string;
  /** 連絡事項・備考 */
  notes: string;
}

export const COVER_LETTER_KIND_META: Record<CoverLetterKind, { label: string; title: string; fileNamePrefix: string }> = {
  document: { label: "書類送付状", title: "書類送付のご案内", fileNamePrefix: "書類送付状" },
  fax: { label: "FAX送付状", title: "FAX送付のご案内", fileNamePrefix: "FAX送付状" },
};

/** 送付書類の、よく使う書類名（入力の候補） */
export const COMMON_DOCUMENT_NAMES = ["見積書", "請求書", "納品書", "注文書", "領収書", "契約書", "申込書", "会社案内", "パンフレット", "資料"];

export function defaultGreeting(kind: CoverLetterKind): string {
  const send = kind === "fax" ? "下記のとおりFAXにてお送りいたします。" : "下記の書類をお送りいたします。";
  return [
    "拝啓　時下ますますご清栄のこととお慶び申し上げます。",
    "平素は格別のお引き立てを賜り、厚く御礼申し上げます。",
    `さて、${send}`,
    "ご査収のほど、よろしくお願い申し上げます。",
    "敬具",
  ].join("\n");
}

let idCounter = 0;
export function newItemId(): string {
  idCounter += 1;
  return `cl-item-${Date.now().toString(36)}-${idCounter}`;
}

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function createEmptySender(): CoverLetterSender {
  return { companyName: "", department: "", contactName: "", postalCode: "", address: "", tel: "", fax: "", email: "" };
}

export function createEmptyCoverLetter(kind: CoverLetterKind = "document", now = new Date()): CoverLetterForm {
  return {
    kind,
    date: todayIso(now),
    subject: "",
    recipient: { companyName: "", department: "", contactName: "", fax: "", tel: "" },
    sender: createEmptySender(),
    greeting: defaultGreeting(kind),
    items: [{ id: newItemId(), name: "", copies: "1" }],
    faxPages: "",
    notes: "",
  };
}

/** 「2026-11-20」→「2026年11月20日」。形が違えばそのまま */
export function formatJapaneseDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return iso.trim();
  return `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 宛名の行。担当者名があれば「様」、なければ最後の行（部署か会社名）に「御中」。
 * 担当者名にすでに「様」「殿」などが付いていれば、重ねて付けない。
 */
export function recipientLines(r: CoverLetterRecipient): string[] {
  const company = r.companyName.trim();
  const dept = r.department.trim();
  const name = r.contactName.trim();
  const lines: string[] = [];
  if (name) {
    if (company) lines.push(company);
    if (dept) lines.push(dept);
    lines.push(/(様|殿|御中|先生)$/.test(name) ? name : `${name} 様`);
    return lines;
  }
  const org = [company, dept].filter(Boolean);
  if (org.length === 0) return [];
  org.forEach((line, i) => lines.push(i === org.length - 1 && !/御中$/.test(line) ? `${line} 御中` : line));
  return lines;
}

/** 差出人の行（会社名・部署・担当者・住所・連絡先） */
export function senderLines(s: CoverLetterSender): string[] {
  const lines: string[] = [];
  if (s.companyName.trim()) lines.push(s.companyName.trim());
  if (s.department.trim()) lines.push(s.department.trim());
  if (s.contactName.trim()) lines.push(s.contactName.trim());
  if (s.postalCode.trim()) lines.push(`〒${s.postalCode.trim().replace(/^〒/, "")}`);
  if (s.address.trim()) lines.push(s.address.trim());
  if (s.tel.trim()) lines.push(`TEL：${s.tel.trim()}`);
  if (s.fax.trim()) lines.push(`FAX：${s.fax.trim()}`);
  if (s.email.trim()) lines.push(`メール：${s.email.trim()}`);
  return lines;
}

/** 送付書類の行（空の行は除く）。「見積書　1部」 */
export function itemLines(items: CoverLetterItem[]): string[] {
  return items
    .filter((it) => it.name.trim() !== "")
    .map((it) => {
      const copies = it.copies.trim();
      if (copies === "") return it.name.trim();
      return /^\d+$/.test(copies) ? `${it.name.trim()}　${copies}部` : `${it.name.trim()}　${copies}`;
    });
}

/** 見出し（件名が空なら種類ごとの見出し） */
export function coverLetterTitle(form: CoverLetterForm): string {
  return form.subject.trim() || COVER_LETTER_KIND_META[form.kind].title;
}

/** 作れないときの理由（作れるなら null） */
export function validateCoverLetter(form: CoverLetterForm): string | null {
  if (recipientLines(form.recipient).length === 0) return "宛先の会社名・部署・担当者名のどれかを入力してください";
  if (senderLines(form.sender).length === 0) return "差出人の会社名・氏名などを入力してください";
  if (form.kind === "document" && itemLines(form.items).length === 0) return "送付書類を1つ以上入力してください";
  const pages = form.faxPages.trim();
  if (form.kind === "fax" && pages !== "" && !/^\d{1,3}$/.test(pages)) return "送信枚数は数字で入力してください";
  return null;
}

/** ファイル名（例: 書類送付状_株式会社サンプル_2026-11-20.pdf）。ファイル名に使えない文字は呼び出し側で整える */
export function coverLetterBaseName(form: CoverLetterForm): string {
  const to = form.recipient.companyName.trim() || form.recipient.contactName.trim();
  return [COVER_LETTER_KIND_META[form.kind].fileNamePrefix, to, form.date || todayIso()].filter(Boolean).join("_");
}

// ───────────── 差出人の保存（この端末のブラウザの中だけ） ─────────────

export const SENDER_STORAGE_KEY = "mrsatto:cover-letter:sender:v1";

/** 保存した差出人を読む（なければ・壊れていれば null） */
export function parseStoredSender(raw: string | null): CoverLetterSender | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const base = createEmptySender();
    const out = { ...base };
    for (const key of Object.keys(base) as (keyof CoverLetterSender)[]) {
      const v = data[key];
      if (typeof v === "string") out[key] = v.slice(0, 200);
    }
    return senderLines(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
