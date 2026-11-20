/**
 * 送付状（書類送付状・FAX送付状）の入力と、文面の組み立て（2026-11-20）。
 *
 * - 書類を郵送・手渡しするときの「書類送付状」と、FAXで送るときの「FAX送付状」の2種類。
 * - 宛名の敬称は、担当者名があれば「様」、会社名・部署だけなら「御中」を自動で付ける（「御中」と「様」は重ねない）。
 * - あいさつ文は、ひな形を入れておき、利用者が自由に書き換えられる。
 * - 画面のプレビューとPDF・Wordは、どちらもこのファイルの関数で文面を組み立てる（表示の食い違いを防ぐ）。
 * - 2026-11-20：宛先を複数入れると、宛先ごとに1枚ずつ（同じ本文で）まとめて作る。宛先・差出人は、Excelの行や
 *   メールの署名などを貼り付けて入れられる（parseRecipientRows・parsePartyText）。
 * - 2026-11-20：各項目（日付・宛先・差出人・件名・本文・記・連絡事項）の位置を、横・縦にmm単位でずらせる（layout）。
 *   PDF・Word・プレビューのどれにも同じずらし量を使う。
 */

export type CoverLetterKind = "document" | "fax";

export interface CoverLetterRecipient {
  /** 画面の並び・削除用の目印（個人情報を含まない） */
  id?: string;
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

/** 位置をずらせる項目 */
export type CoverLetterBlock = "date" | "recipient" | "sender" | "title" | "body" | "items" | "notes";

export const COVER_LETTER_BLOCKS: { id: CoverLetterBlock; label: string }[] = [
  { id: "date", label: "日付" },
  { id: "recipient", label: "宛先" },
  { id: "sender", label: "差出人" },
  { id: "title", label: "件名" },
  { id: "body", label: "あいさつ文" },
  { id: "items", label: "記（送付書類）" },
  { id: "notes", label: "連絡事項" },
];

/**
 * 1行ずつ動かせる項目（宛先・差出人の中の、会社名・住所・電話など。2026-11-20）。
 * まとまり（CoverLetterBlock）のずらしに足して、その行だけを動かす（ほかの行の位置は変えない）。
 */
export type CoverLetterLine =
  | "recipient.company"
  | "recipient.department"
  | "recipient.name"
  | "recipient.contact"
  | "sender.company"
  | "sender.department"
  | "sender.name"
  | "sender.postal"
  | "sender.address"
  | "sender.tel"
  | "sender.fax"
  | "sender.email";

export const COVER_LETTER_LINES: { id: CoverLetterLine; label: string; group: "recipient" | "sender" }[] = [
  { id: "recipient.company", label: "宛先の会社名", group: "recipient" },
  { id: "recipient.department", label: "宛先の部署名", group: "recipient" },
  { id: "recipient.name", label: "宛先の担当者名", group: "recipient" },
  { id: "recipient.contact", label: "宛先のFAX・電話", group: "recipient" },
  { id: "sender.company", label: "差出人の会社名", group: "sender" },
  { id: "sender.department", label: "差出人の部署名", group: "sender" },
  { id: "sender.name", label: "差出人の担当者名", group: "sender" },
  { id: "sender.postal", label: "差出人の郵便番号", group: "sender" },
  { id: "sender.address", label: "差出人の住所", group: "sender" },
  { id: "sender.tel", label: "差出人の電話番号", group: "sender" },
  { id: "sender.fax", label: "差出人のFAX番号", group: "sender" },
  { id: "sender.email", label: "差出人のメール", group: "sender" },
];

export type CoverLetterLayoutKey = CoverLetterBlock | CoverLetterLine;

/** 動かせる項目すべて（まとまり＋1行ずつの項目）の名前 */
export const COVER_LETTER_LAYOUT_ITEMS: { id: CoverLetterLayoutKey; label: string }[] = [
  ...COVER_LETTER_BLOCKS.map((b) => ({ id: b.id as CoverLetterLayoutKey, label: b.id === "recipient" || b.id === "sender" ? `${b.label}（まとめて）` : b.label })),
  ...COVER_LETTER_LINES.map((l) => ({ id: l.id as CoverLetterLayoutKey, label: l.label })),
];

/** 項目ごとのずらし量（mm）。x は右へ、y は下へ。0 なら標準の位置 */
export type CoverLetterLayout = Record<CoverLetterLayoutKey, { x: number; y: number }>;

/** ずらせる範囲（mm） */
export const LAYOUT_X_RANGE = { min: -40, max: 40 } as const;
export const LAYOUT_Y_RANGE = { min: -20, max: 60 } as const;

const ALL_LAYOUT_KEYS: CoverLetterLayoutKey[] = COVER_LETTER_LAYOUT_ITEMS.map((i) => i.id);

export function createDefaultLayout(): CoverLetterLayout {
  return Object.fromEntries(ALL_LAYOUT_KEYS.map((k) => [k, { x: 0, y: 0 }])) as CoverLetterLayout;
}

/** ずらし量を範囲に収める（壊れた値・ない値は0） */
export function clampLayout(layout: Partial<CoverLetterLayout> | undefined): CoverLetterLayout {
  const out = createDefaultLayout();
  for (const k of ALL_LAYOUT_KEYS) {
    const x = Number(layout?.[k]?.x);
    const y = Number(layout?.[k]?.y);
    out[k] = {
      x: Number.isFinite(x) ? Math.min(LAYOUT_X_RANGE.max, Math.max(LAYOUT_X_RANGE.min, x)) : 0,
      y: Number.isFinite(y) ? Math.min(LAYOUT_Y_RANGE.max, Math.max(LAYOUT_Y_RANGE.min, y)) : 0,
    };
  }
  return out;
}

/** 位置を標準から変えているか */
export function isLayoutChanged(layout: CoverLetterLayout): boolean {
  return ALL_LAYOUT_KEYS.some((k) => isItemMoved(layout, k));
}

/** その項目を、標準の位置から動かしているか */
export function isItemMoved(layout: CoverLetterLayout, key: CoverLetterLayoutKey): boolean {
  return (layout[key]?.x ?? 0) !== 0 || (layout[key]?.y ?? 0) !== 0;
}

export interface CoverLetterForm {
  kind: CoverLetterKind;
  /** 日付（YYYY-MM-DD） */
  date: string;
  /** 件名（空なら種類ごとの見出し） */
  subject: string;
  /** 宛先（1件以上）。宛先ごとに1枚ずつ作る。空の宛先は作らない */
  recipients: CoverLetterRecipient[];
  sender: CoverLetterSender;
  /** あいさつ文（拝啓〜敬具まで。空なら書かない） */
  greeting: string;
  items: CoverLetterItem[];
  /** FAXの送信枚数（本紙を含む。FAX送付状のときだけ） */
  faxPages: string;
  /** 連絡事項・備考 */
  notes: string;
  /** 各項目の位置のずらし量（mm） */
  layout: CoverLetterLayout;
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

export function createEmptyRecipient(): CoverLetterRecipient {
  return { id: newItemId(), companyName: "", department: "", contactName: "", fax: "", tel: "" };
}

/** 宛先が空か（会社名・部署名・担当者名のどれもない） */
export function isRecipientEmpty(r: CoverLetterRecipient): boolean {
  return recipientLines(r).length === 0;
}

/** 作る宛先（空の宛先を除く） */
export function activeRecipients(form: CoverLetterForm): CoverLetterRecipient[] {
  return form.recipients.filter((r) => !isRecipientEmpty(r));
}

/** 一度に作れる宛先の数 */
export const MAX_RECIPIENTS = 200;

export function createEmptyCoverLetter(kind: CoverLetterKind = "document", now = new Date()): CoverLetterForm {
  return {
    kind,
    date: todayIso(now),
    subject: "",
    recipients: [createEmptyRecipient()],
    sender: createEmptySender(),
    greeting: defaultGreeting(kind),
    items: [{ id: newItemId(), name: "", copies: "1" }],
    faxPages: "",
    notes: "",
    layout: createDefaultLayout(),
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
  return recipientLineEntries(r).map((e) => e.text);
}

/** 宛名の行と、その行がどの項目か（1行ずつ位置を動かすため） */
export function recipientLineEntries(r: CoverLetterRecipient): { key: CoverLetterLine; text: string }[] {
  const company = r.companyName.trim();
  const dept = r.department.trim();
  const name = r.contactName.trim();
  const lines: { key: CoverLetterLine; text: string }[] = [];
  if (name) {
    if (company) lines.push({ key: "recipient.company", text: company });
    if (dept) lines.push({ key: "recipient.department", text: dept });
    lines.push({ key: "recipient.name", text: /(様|殿|御中|先生)$/.test(name) ? name : `${name} 様` });
    return lines;
  }
  const org: { key: CoverLetterLine; text: string }[] = [];
  if (company) org.push({ key: "recipient.company", text: company });
  if (dept) org.push({ key: "recipient.department", text: dept });
  org.forEach((e, i) => lines.push(i === org.length - 1 && !/御中$/.test(e.text) ? { key: e.key, text: `${e.text} 御中` } : e));
  return lines;
}

/** 差出人の行（会社名・部署・担当者・住所・連絡先） */
export function senderLines(s: CoverLetterSender): string[] {
  return senderLineEntries(s).map((e) => e.text);
}

/** 差出人の行と、その行がどの項目か（1行ずつ位置を動かすため） */
export function senderLineEntries(s: CoverLetterSender): { key: CoverLetterLine; text: string }[] {
  const lines: { key: CoverLetterLine; text: string }[] = [];
  if (s.companyName.trim()) lines.push({ key: "sender.company", text: s.companyName.trim() });
  if (s.department.trim()) lines.push({ key: "sender.department", text: s.department.trim() });
  if (s.contactName.trim()) lines.push({ key: "sender.name", text: s.contactName.trim() });
  if (s.postalCode.trim()) lines.push({ key: "sender.postal", text: `〒${s.postalCode.trim().replace(/^〒/, "")}` });
  if (s.address.trim()) lines.push({ key: "sender.address", text: s.address.trim() });
  if (s.tel.trim()) lines.push({ key: "sender.tel", text: `TEL：${s.tel.trim()}` });
  if (s.fax.trim()) lines.push({ key: "sender.fax", text: `FAX：${s.fax.trim()}` });
  if (s.email.trim()) lines.push({ key: "sender.email", text: `メール：${s.email.trim()}` });
  return lines;
}

/** 宛先のFAX・電話の行（FAX送付状のときだけ。なければ空文字） */
export function recipientContactLine(kind: CoverLetterKind, r: CoverLetterRecipient): string {
  if (kind !== "fax") return "";
  return [r.fax.trim() && `FAX：${r.fax.trim()}`, r.tel.trim() && `TEL：${r.tel.trim()}`].filter(Boolean).join("　");
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
  const active = activeRecipients(form);
  if (active.length === 0) return "宛先の会社名・部署・担当者名のどれかを入力してください";
  if (active.length > MAX_RECIPIENTS) return `一度に作れる宛先は${MAX_RECIPIENTS}件までです`;
  if (senderLines(form.sender).length === 0) return "差出人の会社名・氏名などを入力してください";
  if (form.kind === "document" && itemLines(form.items).length === 0) return "送付書類を1つ以上入力してください";
  const pages = form.faxPages.trim();
  if (form.kind === "fax" && pages !== "" && !/^\d{1,3}$/.test(pages)) return "送信枚数は数字で入力してください";
  return null;
}

/** ファイル名（例: 書類送付状_株式会社サンプル_2026-11-20、複数なら 書類送付状_3件_2026-11-20）。拡張子は呼び出し側で付ける */
export function coverLetterBaseName(form: CoverLetterForm): string {
  const active = activeRecipients(form);
  const first = active[0];
  const to = active.length > 1 ? `${active.length}件` : first ? first.companyName.trim() || first.contactName.trim() || first.department.trim() : "";
  return [COVER_LETTER_KIND_META[form.kind].fileNamePrefix, to, form.date || todayIso()].filter(Boolean).join("_");
}

// ───────────── 貼り付けから入れる ─────────────

type RecipientKey = Exclude<keyof CoverLetterRecipient, "id">;
const RECIPIENT_ORDER: RecipientKey[] = ["companyName", "department", "contactName", "fax", "tel"];

/** 見出しの文字から、宛先のどの項目かを決める（分からなければ null） */
function headerKey(cell: string): RecipientKey | null {
  const c = cell.replace(/\s/g, "");
  if (/FAX|ＦＡＸ|ファックス|ﾌｧｯｸｽ/i.test(c)) return "fax";
  if (/TEL|ＴＥＬ|電話/i.test(c)) return "tel";
  if (/部署|部門|所属|課/.test(c)) return "department";
  if (/担当|氏名|名前|宛名|個人/.test(c)) return "contactName";
  if (/会社|社名|法人|団体|屋号|取引先|宛先/.test(c)) return "companyName";
  return null;
}

function splitRow(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  // CSV（ダブルクォートで囲んだ値の中のカンマは区切らない）
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if ((ch === "," || ch === "，") && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 会社名の末尾の「御中」、担当者名の末尾の「様」「殿」を取る（敬称はこちらで付ける） */
function stripHonorific(key: RecipientKey, value: string): string {
  const v = value.trim();
  if (key === "contactName") return v.replace(/\s*(様|殿|さま)$/, "");
  if (key === "companyName" || key === "department") return v.replace(/\s*御中$/, "");
  return v;
}

/**
 * Excelからコピーした表（タブ区切り）やCSVの行を、宛先の一覧にする。
 * - 1行目が見出し（「会社名」「部署」「担当者」「FAX」「電話」など）なら、その並びで読む。
 * - 見出しがなければ「会社名・部署名・担当者名・FAX・電話」の順とみなす。
 * - 区切りのない1列だけの貼り付けは、1行＝1社（会社名）として読む。
 */
export function parseRecipientRows(text: string): CoverLetterRecipient[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const rows = lines.map(splitRow);
  let order: (RecipientKey | null)[] = RECIPIENT_ORDER;
  const headerGuess = rows[0].map(headerKey);
  if (headerGuess.filter(Boolean).length >= Math.max(1, Math.ceil(rows[0].length / 2))) {
    order = headerGuess;
    rows.shift();
  }
  const out: CoverLetterRecipient[] = [];
  for (const cells of rows) {
    const r = createEmptyRecipient();
    cells.forEach((cell, i) => {
      const key = order[i];
      if (key) r[key] = stripHonorific(key, cell).slice(0, 100);
    });
    if (!isRecipientEmpty(r)) out.push(r);
  }
  return out.slice(0, MAX_RECIPIENTS);
}

const POSTAL_RE = /〒?\s*(\d{3})[-－ー‐]?(\d{4})/;
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const PHONE_RE = /(\+?\d[\d\-－ー‐()（） ]{8,}\d)/;
const COMPANY_RE = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|社会福祉法人|学校法人|医療法人|NPO法人|特定非営利活動法人|\(株\)|（株）|\(有\)|（有）|事務所|商店|工業|商事|産業|組合|協会|大学|学園|病院|クリニック|役所|役場|市役所|区役所)/;
const DEPT_RE = /(部|課|室|係|局|センター|グループ|チーム|支店|営業所|事業所|本部)$/;
const ADDRESS_RE = /(都|道|府|県|市|区|町|村|丁目|番地|\d+-\d+)/;

function normalizeDigits(s: string): string {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[－ー‐]/g, "-");
}

/**
 * メールの署名・名刺の文字などを貼り付けたものから、会社名・部署名・担当者名・住所・電話などを取り出す。
 * 行ごとに「TEL」「FAX」「〒」「@」などの手がかりで決め、決まらない行は会社名→部署名→担当者名の順に入れる。
 * 完全ではないので、入れたあと画面で直せるようにする。
 */
export function parsePartyText(text: string): CoverLetterSender {
  const out = createEmptySender();
  const rest: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    let line = raw.trim().replace(/^[■□●・\-－*＊]+\s*/, "");
    if (line === "" || /^[-=_－―ー*＊~〜]{3,}$/.test(line)) continue;
    const n = normalizeDigits(line);
    if (EMAIL_RE.test(n) && !out.email) {
      out.email = n.match(EMAIL_RE)![0];
      line = n.replace(EMAIL_RE, "").replace(/(E-?mail|メール|Mail)\s*[:：]?/i, "").trim();
      if (line === "") continue;
    }
    // 1行に「TEL ... FAX ...」が並ぶこともある
    const fax = /(FAX|ＦＡＸ|ファックス)\s*[:：]?\s*([\d\-()（） ]{9,})/i.exec(normalizeDigits(line));
    const tel = /(TEL|ＴＥＬ|電話|Tel|Phone|携帯)\s*[:：]?\s*([\d\-()（） ]{9,})/i.exec(normalizeDigits(line));
    if (fax || tel) {
      if (fax && !out.fax) out.fax = fax[2].trim();
      if (tel && !out.tel) out.tel = tel[2].trim();
      continue;
    }
    const postal = POSTAL_RE.exec(n);
    if (postal && (n.includes("〒") || /^\d{3}-\d{4}/.test(n))) {
      out.postalCode = `${postal[1]}-${postal[2]}`;
      const after = n.replace(POSTAL_RE, "").trim();
      if (after && !out.address) out.address = after;
      continue;
    }
    if (!out.tel && PHONE_RE.test(n) && /^[\d\-()（） +]+$/.test(n)) {
      out.tel = n.trim();
      continue;
    }
    rest.push(line);
  }
  for (const line of rest) {
    if (!out.companyName && COMPANY_RE.test(line)) out.companyName = line;
    else if (!out.address && ADDRESS_RE.test(line) && /\d|丁目|番地/.test(normalizeDigits(line)) && line.length >= 6) out.address = line;
    else if (!out.department && DEPT_RE.test(line.split(/\s+/)[0])) {
      // 「営業部 山田 太郎」のように1行に部署と名前があるとき
      const parts = line.split(/\s+/);
      out.department = parts[0];
      if (parts.length > 1 && !out.contactName) out.contactName = parts.slice(1).join(" ");
    } else if (!out.contactName) out.contactName = line.replace(/\s*(様|殿)$/, "");
    else if (!out.companyName) out.companyName = line;
  }
  for (const key of Object.keys(out) as (keyof CoverLetterSender)[]) out[key] = out[key].slice(0, 200);
  return out;
}

/** 貼り付けた文字から、宛先1件を取り出す（署名などの文字を、宛先の項目にあてはめる） */
export function parseRecipientText(text: string): CoverLetterRecipient {
  const p = parsePartyText(text);
  return { id: newItemId(), companyName: stripHonorific("companyName", p.companyName), department: stripHonorific("department", p.department), contactName: stripHonorific("contactName", p.contactName), fax: p.fax, tel: p.tel };
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
