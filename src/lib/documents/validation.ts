import { parseQuantity, parseUnitPrice } from "./calc";
import { TAX_RATE_OPTIONS, isPartyEmpty, type DocumentFormState, type LineItemInput } from "./types";

/**
 * 明細行が「未入力（追加したがまだ何も書いていない空行）」かどうか。
 * 数量・単位は初期値が入っているため、品名と単価がどちらも空なら
 * 実質未入力の行とみなし、明細0件チェックや数量/単価チェックの対象から外す
 * （入力を始めていない空行があるだけでエラーにしてしまうと使いにくいため）。
 */
function isLineItemBlank(item: LineItemInput): boolean {
  return item.name.trim() === "" && item.unitPrice.trim() === "";
}

/**
 * 帳票フォームのバリデーション（開発指示書■22）。
 *
 * 最初に見つかった問題を日本語メッセージ1件として返す（他のProcessor群と
 * 同様、UI側は単一のエラーメッセージを ErrorMessage で表示する設計のため）。
 * 問題がなければ null を返す。
 *
 * 全項目を必須にはしない（■22後半）。品名・備考・振込先などは空でもよい。
 */
export function validateDocumentForm(form: DocumentFormState): string | null {
  if (form.documentNumber.trim() === "") {
    return "書類番号を入力してください";
  }

  if (isPartyEmpty(form.issuer)) {
    return "発行者情報を入力してください（会社名・住所など、いずれか1つ以上）";
  }

  if (isPartyEmpty(form.recipient)) {
    return "宛先情報を入力してください（会社名・住所など、いずれか1つ以上）";
  }

  const meaningfulItems = form.items.filter((item) => !isLineItemBlank(item));
  if (meaningfulItems.length === 0) {
    return "明細を1件以上入力してください";
  }

  for (let i = 0; i < meaningfulItems.length; i++) {
    const item = meaningfulItems[i];
    const rowNumber = form.items.indexOf(item) + 1;
    if (parseQuantity(item.quantity) === null) {
      return `明細${rowNumber}行目の数量が正しくありません（0以上の数値を入力してください）`;
    }
    if (parseUnitPrice(item.unitPrice) === null) {
      return `明細${rowNumber}行目の単価が正しくありません（0以上の数値を入力してください）`;
    }
  }

  if (!TAX_RATE_OPTIONS.includes(form.taxRatePercent)) {
    return "消費税率が正しくありません";
  }

  return null;
}
