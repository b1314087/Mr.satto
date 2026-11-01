import {
  createEmptyLineItem,
  nextLineItemId,
  type BankAccountInfo,
  type DocumentFormState,
  type DocumentType,
  type LineItemInput,
  type PartyInfo,
  type TaxRatePercent,
  type TaxRounding,
} from "./types";

/**
 * メモの貼り付けで、帳票の入力欄をまとめて埋める（AIは使わない）。
 *
 * 書き方：1行に「項目名：中身」。「：」は全角・半角どちらでもよい。
 *   宛先：株式会社お客様商事
 *   明細：外壁塗装工事, 1, 式, 100000
 * - 空行と「#」で始まる行は読み飛ばす
 * - 読めなかった行は、行番号と理由を返す（黙って捨てない）
 * - メモに書いた項目だけを上書きする。明細を1行でも書いたときは、明細を書いた内容に置き換える
 * - すべてブラウザの中で処理する
 */

export interface MemoImportIssue {
  line: number;
  text: string;
  reason: string;
}

export interface MemoImportResult {
  patch: Partial<DocumentFormState>;
  /** 「納期」の行の中身（そのまま）。見積書・注文書の一体作成は、注文書の納期の欄に入れる */
  deliveryText: string | null;
  /** 入れた項目の名前（表示用） */
  applied: string[];
  issues: MemoImportIssue[];
}

type PartyField = keyof PartyInfo;
type BankField = keyof BankAccountInfo;

const PARTY_FIELD_ALIASES: Record<string, PartyField> = {
  "": "companyName",
  会社: "companyName",
  会社名: "companyName",
  名: "companyName",
  名前: "companyName",
  担当: "contactName",
  担当者: "contactName",
  担当者名: "contactName",
  郵便番号: "postalCode",
  "〒": "postalCode",
  住所: "address",
  電話: "tel",
  電話番号: "tel",
  tel: "tel",
  メール: "email",
  メールアドレス: "email",
  email: "email",
};

const PARTY_FIELD_LABELS: Record<PartyField, string> = {
  companyName: "会社名",
  contactName: "担当者",
  postalCode: "郵便番号",
  address: "住所",
  tel: "電話",
  email: "メール",
};

/** 宛先・発行者の呼び方（先頭の語） */
const PARTY_PREFIXES: { prefix: string; target: "recipient" | "issuer"; label: string }[] = [
  { prefix: "宛先", target: "recipient", label: "宛先" },
  { prefix: "宛名", target: "recipient", label: "宛先" },
  { prefix: "取引先", target: "recipient", label: "宛先" },
  { prefix: "お客様", target: "recipient", label: "宛先" },
  { prefix: "発行者", target: "issuer", label: "発行者" },
  { prefix: "自社", target: "issuer", label: "発行者" },
];

const BANK_ALIASES: Record<string, BankField> = {
  銀行: "bankName",
  銀行名: "bankName",
  金融機関: "bankName",
  支店: "branchName",
  支店名: "branchName",
  口座種別: "accountType",
  種別: "accountType",
  預金種別: "accountType",
  口座番号: "accountNumber",
  口座名義: "accountHolder",
  名義: "accountHolder",
};

const BANK_LABELS: Record<BankField, string> = {
  bankName: "銀行名",
  branchName: "支店名",
  accountType: "口座種別",
  accountNumber: "口座番号",
  accountHolder: "口座名義",
};

const ROUNDING_WORDS: Record<string, TaxRounding> = {
  切り捨て: "floor",
  切捨て: "floor",
  切捨: "floor",
  四捨五入: "round",
  切り上げ: "ceil",
  切上げ: "ceil",
  切上: "ceil",
};

/** 全角の英数字・記号を半角へ（キーの照合・数字の読み取り用） */
export function toHalfWidth(s: string): string {
  return s
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, " ");
}

function normalizeKey(raw: string): string {
  return toHalfWidth(raw)
    .replace(/[\s【】\[\]「」()（）・]/g, "")
    .toLowerCase();
}

/** 「2026/11/01」「2026-11-1」「2026年11月1日」「2026.11.1」→ "2026-11-01"。読めなければ null */
export function parseMemoDate(raw: string): string | null {
  const s = toHalfWidth(raw).trim();
  const m = /^(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})\s*日?$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 「¥100,000円」「100000」→ "100000"。数字として読めなければ null */
export function parseMemoNumber(raw: string): string | null {
  const s = toHalfWidth(raw).replace(/[¥￥円,\s]/g, "").replace(/^\\/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  return s;
}

/**
 * 明細の中身を区切る。タブがあればタブで、なければ「,」「、」「，」で区切る。
 * 数字のすぐ後のカンマに3桁の数字が続く（「100,000」）ときは、桁区切りとみなして区切らない。
 */
export function splitItemFields(raw: string): string[] {
  const s = toHalfWidth(raw);
  if (s.includes("\t")) return s.split("\t").map((x) => x.trim());
  return s.split(/[、]|,(?!(?<=\d,)\d{3}(?:\D|$))/).map((x) => x.trim());
}

function parseItem(raw: string): LineItemInput | string {
  const f = splitItemFields(raw).filter((x, i, a) => !(x === "" && i === a.length - 1));
  let name = "";
  let quantity = "1";
  let unit = "式";
  let price: string | null = null;
  if (f.length === 4) {
    [name, quantity, unit] = f;
    price = f[3];
  } else if (f.length === 3) {
    [name, quantity] = f;
    price = f[2];
  } else if (f.length === 2) {
    name = f[0];
    price = f[1];
  } else {
    return "明細は「品名, 数量, 単位, 単価」の形で書いてください";
  }
  if (name === "") return "品名がありません";
  const q = parseMemoNumber(quantity);
  if (q === null) return `数量「${quantity}」を数字として読めません`;
  const p = parseMemoNumber(price);
  if (p === null) return `単価「${price}」を数字として読めません`;
  return { ...createEmptyLineItem(nextLineItemId()), name, quantity: q, unit: unit || "式", unitPrice: p };
}

/** 記入例（「記入例を入れる」で使う） */
export function memoTemplate(type: DocumentType, options: { deliveryTextField?: boolean } = {}): string {
  const due = { estimate: "有効期限", invoice: "支払期限", order: "納期" }[type];
  const lines = [
    "書類番号：INV-20261101-001",
    "発行日：2026/11/01",
    `${due}：2026/11/30`,
    "宛先：株式会社お客様商事",
    "宛先担当：山田 太郎",
    "宛先郵便番号：100-0001",
    "宛先住所：東京都千代田区1-1-1",
    "発行者：株式会社テスト工務店",
    "発行者住所：大阪府大阪市2-2-2",
    "発行者電話：06-0000-0000",
    "明細：外壁塗装工事, 1, 式, 100000",
    "明細：足場設置, 2, 日, 15000",
    "税率：10",
    "備考：お支払いは月末締め翌月末払い",
  ];
  if (type === "estimate") lines[0] = "書類番号：EST-20261101-001";
  if (type === "order") lines[0] = "書類番号：ORD-20261101-001";
  if (options.deliveryTextField) lines.splice(3, 0, "納期：受注後2週間");
  if (type === "invoice") {
    lines.splice(
      lines.length - 1,
      0,
      "銀行：〇〇銀行",
      "支店：本店営業部",
      "口座種別：普通",
      "口座番号：1234567",
      "口座名義：カ）テストコウムテン"
    );
  }
  return lines.join("\n");
}

export function parseDocumentMemo(
  text: string,
  current: DocumentFormState,
  options: { deliveryTextField?: boolean } = {}
): MemoImportResult {
  const patch: Partial<DocumentFormState> = {};
  const applied: string[] = [];
  const issues: MemoImportIssue[] = [];
  let deliveryText: string | null = null;
  const items: LineItemInput[] = [];
  const notes: string[] = [];
  const recipient: Partial<PartyInfo> = {};
  const issuer: Partial<PartyInfo> = {};
  const bank: Partial<BankAccountInfo> = {};

  const note = (label: string) => {
    if (!applied.includes(label)) applied.push(label);
  };

  text.split(/\r?\n/).forEach((rawLine, idx) => {
    const line = rawLine.trim();
    const lineNo = idx + 1;
    if (line === "" || line.startsWith("#") || line.startsWith("＃")) return;
    const m = /^([^:：]+)[:：](.*)$/.exec(line);
    if (!m) {
      issues.push({ line: lineNo, text: line, reason: "「項目名：中身」の形になっていません" });
      return;
    }
    const key = normalizeKey(m[1]);
    const value = m[2].trim();
    const fail = (reason: string) => issues.push({ line: lineNo, text: line, reason });

    if (value === "") {
      fail("中身が空です");
      return;
    }

    switch (key) {
      case "書類番号":
      case "番号":
      case "管理番号":
      case "見積番号":
      case "請求番号":
      case "注文番号":
        patch.documentNumber = value;
        note("書類番号");
        return;
      case "タイトル":
      case "書類タイトル":
      case "件名":
        patch.title = value;
        note("書類タイトル");
        return;
      case "発行日":
      case "日付": {
        const d = parseMemoDate(value);
        if (!d) return fail("日付は「2026/11/01」の形で書いてください");
        patch.issueDate = d;
        note("発行日");
        return;
      }
      case "期限":
      case "有効期限":
      case "支払期限":
      case "支払期日":
      case "お支払期限": {
        const d = parseMemoDate(value);
        if (!d) return fail("日付は「2026/11/30」の形で書いてください");
        patch.secondaryDate = d;
        note("期限");
        return;
      }
      case "納期": {
        if (options.deliveryTextField) {
          // 見積書・注文書の一体作成：注文書の納期の欄（自由な文字）にそのまま入れる
          deliveryText = value;
        } else if (current.type === "order") {
          // 注文書は「納期」が2つ目の日付の欄
          const d = parseMemoDate(value);
          if (!d) return fail("日付は「2026/11/30」の形で書いてください");
          patch.secondaryDate = d;
        } else {
          return fail("この書類には納期の欄がありません");
        }
        note("納期");
        return;
      }
      case "明細":
      case "品目": {
        const item = parseItem(value);
        if (typeof item === "string") return fail(item);
        items.push(item);
        return;
      }
      case "税率":
      case "消費税":
      case "消費税率": {
        const n = toHalfWidth(value).replace(/[%％\s]/g, "");
        if (n !== "10" && n !== "8" && n !== "0") return fail("税率は 10・8・0 のどれかで書いてください");
        patch.taxRatePercent = Number(n) as TaxRatePercent;
        note("税率");
        return;
      }
      case "端数":
      case "端数処理": {
        const r = ROUNDING_WORDS[value.replace(/\s/g, "")];
        if (!r) return fail("端数は「切り捨て」「四捨五入」「切り上げ」のどれかで書いてください");
        patch.taxRounding = r;
        note("端数処理");
        return;
      }
      case "備考":
      case "メモ":
        notes.push(value);
        return;
    }

    if (key in BANK_ALIASES) {
      if (current.type !== "invoice") return fail("振込先は請求書だけに入れられます");
      const field = BANK_ALIASES[key];
      if (field === "accountType" && value !== "普通" && value !== "当座") {
        return fail("口座種別は「普通」か「当座」で書いてください");
      }
      bank[field] = field === "accountNumber" ? toHalfWidth(value).replace(/\s/g, "") : value;
      note(BANK_LABELS[field]);
      return;
    }

    for (const p of PARTY_PREFIXES) {
      if (!key.startsWith(p.prefix)) continue;
      const rest = key.slice(p.prefix.length);
      const field = PARTY_FIELD_ALIASES[rest];
      if (!field) break;
      (p.target === "recipient" ? recipient : issuer)[field] = value;
      note(`${p.label}の${PARTY_FIELD_LABELS[field]}`);
      return;
    }

    fail(`「${m[1].trim()}」という項目はありません`);
  });

  if (items.length > 0) {
    patch.items = items;
    note(`明細（${items.length}行）`);
  }
  if (notes.length > 0) {
    patch.notes = notes.join("\n");
    note("備考");
  }
  if (Object.keys(recipient).length > 0) patch.recipient = { ...current.recipient, ...recipient };
  if (Object.keys(issuer).length > 0) patch.issuer = { ...current.issuer, ...issuer };
  if (Object.keys(bank).length > 0) patch.bankAccount = { ...current.bankAccount, ...bank };

  return { patch, deliveryText, applied, issues };
}
