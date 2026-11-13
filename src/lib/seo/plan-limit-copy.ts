import type { OnOffCopy } from "@/lib/seo/fiscal-calendar-copy";
import { PLAN_LIMITS, type PlanLimitKey } from "@/lib/plans/tool-limits";

/**
 * ツール説明文のうち、プラン別の上限（src/lib/plans/tool-limits.ts）に触れる部分（2026-11 料金プランの見直し）。
 * tool-content.ts には課金オン時の文言（on）を書き、課金オフ時（プランがなく、だれでもプレミアムの上限で使える）は
 * feature-copy.ts が off の文言（プレミアムの上限だけ）へ差し替える。数字は PLAN_LIMITS から作る（手書きしない）。
 */

const fmt = (n: number) => n.toLocaleString("ja-JP");

/**
 * short：「プレミアムプランで200ページまで・無料プランは1ページまで」（かっこの中の短い説明向け）
 * long ：「プレミアムプランでは1回に200ページまで、無料プランでは1ページまで」（文の中向け）
 */
function limitCopy(key: PlanLimitKey, form: "short" | "long", lead = ""): OnOffCopy {
  const { free, premium, unit } = PLAN_LIMITS[key];
  const p = `${lead}${fmt(premium)}${unit}まで`;
  const f = `${fmt(free)}${unit}まで`;
  return {
    on: form === "short" ? `プレミアムプランで${p}・無料プランは${f}` : `プレミアムプランでは${p}、無料プランでは${f}`,
    off: p,
  };
}

export const PLAN_LIMIT_COPY = {
  ocrShort: limitCopy("pdf-ocr", "short"),
  ocrLong: limitCopy("pdf-ocr", "long", "1回に"),
  pdfToExcelShort: limitCopy("pdf-to-excel", "short"),
  pdfToExcelLong: limitCopy("pdf-to-excel", "long"),
  pdfToWordShort: limitCopy("pdf-to-word", "short"),
  pdfToWordLong: limitCopy("pdf-to-word", "long"),
  envelopeLong: limitCopy("envelope-address", "long", "最大"),
  ticketLong: limitCopy("ticket-voucher", "long", "最大"),
  receiptLong: limitCopy("receipt-accounting-csv", "long"),
} satisfies Record<string, OnOffCopy>;

export const PLAN_LIMIT_COPY_PAIRS: OnOffCopy[] = Object.values(PLAN_LIMIT_COPY);
