/**
 * ハガキ作成・宛名面：Excel・CSVから複数の宛先を読み込む（プレミアム機能）。
 * 1行目は見出し。郵便番号・住所（1〜2列）・氏名・敬称の列を、見出しから推測し、画面で選び直せる。
 * 住所（1列目）が空で郵便番号があるときは、郵便番号から住所（都道府県〜町域）を補う（src/lib/postal、ブラウザの中で検索）。
 */
import type { ParsedTableFile } from "@/lib/utils/table-file";
import type { EnvelopeHonorific } from "./envelope-layout";
import type { PostcardRecipient } from "./postcard-address-layout";
import { entryAddress, normalizeZip, searchByZip } from "@/lib/postal/postal-search";

/** 一度に作れる枚数の上限（PDFが重くなりすぎないように） */
export const POSTCARD_RECIPIENTS_MAX = 500;

export interface RecipientColumns {
  zip: number;
  address1: number;
  /** 建物名など（改行して次の列に入れる）。使わないときは -1 */
  address2: number;
  name: number;
  /** 敬称の列。使わないときは -1（画面で選んだ敬称を使う） */
  honorific: number;
}

const norm = (h: string) => h.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** 見出しから列を推測する。見つからない列は -1 */
export function guessRecipientColumns(headers: string[]): RecipientColumns {
  const hs = headers.map(norm);
  const find = (re: RegExp, exclude?: RegExp, skip: number[] = []) => hs.findIndex((h, i) => !skip.includes(i) && re.test(h) && !(exclude && exclude.test(h)));
  const zip = find(/郵便|〒|zip|postal/);
  const address1 = find(/住所|所在地|address/, /郵便|mail|メール|2|２|建物|ビル/);
  const address2 = find(/住所2|住所２|建物|ビル|マンション|address2|方書/, /郵便|mail|メール/, [address1]);
  const name = find(/氏名|名前|宛名|お名前|name|会社名|社名/, /ふりがな|フリガナ|カナ|kana/);
  const honorific = find(/敬称/);
  return { zip, address1, address2, name, honorific };
}

function toHonorific(v: string): EnvelopeHonorific | undefined {
  const t = v.trim();
  if (t === "様" || t === "さま") return "sama";
  if (t === "御中") return "onchu";
  if (t === "なし" || t === "-" || t === "－") return "none";
  return undefined;
}

/** 列の選択の確認（問題があれば理由） */
export function recipientColumnsError(c: RecipientColumns): string | null {
  if (c.name < 0 && c.address1 < 0) return "氏名の列か住所の列を選んでください。";
  return null;
}

/**
 * 表から宛先の一覧を作る。空の行（郵便番号・住所・氏名がすべて空）は飛ばす。
 * 住所が空で郵便番号が7けたなら、郵便番号から住所を補う（補った件数を返す）。
 */
export async function buildRecipients(table: ParsedTableFile, c: RecipientColumns): Promise<{ recipients: PostcardRecipient[]; filledFromZip: number; skipped: number }> {
  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");
  const recipients: PostcardRecipient[] = [];
  let filledFromZip = 0;
  let skipped = 0;
  for (const row of table.rows) {
    let zip = normalizeZip(cell(row, c.zip));
    // Excelで数値として保存すると、先頭の0が消えて6けたになるため補う
    if (/^\d{6}$/.test(zip)) zip = `0${zip}`;
    const a1 = cell(row, c.address1);
    const a2 = cell(row, c.address2);
    const name = cell(row, c.name);
    if (zip === "" && a1 === "" && a2 === "" && name === "") {
      skipped++;
      continue;
    }
    // 住所（1列目）が空で郵便番号が7けたなら、郵便番号から都道府県〜町域を入れる（建物名の列はその次の列に続ける）
    let main = a1;
    if (main === "" && /^\d{7}$/.test(zip)) {
      const found = (await searchByZip(zip)).results.filter((r) => r.zip === zip);
      if (found.length > 0) {
        main = entryAddress(found[0]);
        filledFromZip++;
      }
    }
    const address = [main, a2].filter((v) => v !== "").join("\n");
    recipients.push({ zip, address, name, honorific: c.honorific >= 0 ? toHonorific(cell(row, c.honorific)) : undefined });
  }
  return { recipients, filledFromZip, skipped };
}

/** 郵便番号（7けた）から住所（都道府県〜町域）を探す。見つからない・複数の住所があるときは null */
export async function addressFromZip(input: string): Promise<string | null> {
  const zip = normalizeZip(input);
  if (!/^\d{7}$/.test(zip)) return null;
  try {
    const found = (await searchByZip(zip)).results.filter((r) => r.zip === zip);
    const addresses = [...new Set(found.map(entryAddress))];
    return addresses.length === 1 ? addresses[0] : null;
  } catch {
    return null;
  }
}
