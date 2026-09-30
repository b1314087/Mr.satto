import { BrowserProcessor } from "../types";
import {
  parseIsoDate,
  formatIsoDate,
  weekdayNameOf,
  addDays,
  startOfMonth,
  endOfMonth,
  isWeekend,
  addBusinessDays,
  listDatesInRange,
} from "@/lib/date/date-utils";

/**
 * 日付・曜日ツール（次工程・軽量便利ツール一括追加 Tool 1）。
 *
 * 指示書が挙げる10個の機能を、1つのツール・1つのProcessorへ
 * モード切替でまとめている（「曜日確認/日付計算/日付一覧/曜日抽出/営業日計算」の
 * 5モード。UIを複雑にしすぎない、という指示に沿い、タブ切り替え程度に留める）。
 */
export type DateToolMode = "weekday" | "shift" | "list" | "business-shift";

export interface DateToolInput {
  mode: DateToolMode;
  /** 基準日（YYYY-MM-DD） */
  baseDate: string;
  /** shift / business-shift モードで使う、符号付きの日数（後ろ向き=正、前向き=負） */
  days?: number;
  /** list モードの終了日（YYYY-MM-DD） */
  rangeEnd?: string;
  /** list モード: 指定曜日だけ抽出する場合の曜日番号(0=日〜6=土)の配列 */
  weekdayFilter?: number[];
  /** list モード: 土日を除外するか */
  excludeWeekends?: boolean;
}

export interface DateListItem {
  date: string;
  weekday: string;
}

export interface DateToolOutput {
  resultDate?: string;
  resultWeekday?: string;
  monthStart?: string;
  monthEnd?: string;
  list?: DateListItem[];
}

function requireDate(value: string | undefined, label: string): Date {
  const parsed = parseIsoDate(value ?? "");
  if (!parsed) {
    throw new Error(`${label}の形式が正しくありません（YYYY-MM-DD形式で入力してください）`);
  }
  return parsed;
}

export class DateToolsProcessor extends BrowserProcessor<DateToolInput, DateToolOutput> {
  async process(input: DateToolInput): Promise<DateToolOutput> {
    const base = requireDate(input.baseDate, "基準日");

    switch (input.mode) {
      case "weekday":
        return {
          resultDate: formatIsoDate(base),
          resultWeekday: weekdayNameOf(base),
          monthStart: formatIsoDate(startOfMonth(base)),
          monthEnd: formatIsoDate(endOfMonth(base)),
        };

      case "shift": {
        if (input.days === undefined || !Number.isFinite(input.days)) {
          throw new Error("日数を入力してください");
        }
        const result = addDays(base, input.days);
        return {
          resultDate: formatIsoDate(result),
          resultWeekday: weekdayNameOf(result),
          monthStart: formatIsoDate(startOfMonth(base)),
          monthEnd: formatIsoDate(endOfMonth(base)),
        };
      }

      case "business-shift": {
        if (input.days === undefined || !Number.isFinite(input.days)) {
          throw new Error("営業日数を入力してください");
        }
        const result = addBusinessDays(base, input.days);
        return { resultDate: formatIsoDate(result), resultWeekday: weekdayNameOf(result) };
      }

      case "list": {
        const end = requireDate(input.rangeEnd, "終了日");
        let dates = listDatesInRange(base, end);
        if (input.excludeWeekends) {
          dates = dates.filter((d) => !isWeekend(d));
        }
        if (input.weekdayFilter && input.weekdayFilter.length > 0) {
          const set = new Set(input.weekdayFilter);
          dates = dates.filter((d) => set.has(d.getDay()));
        }
        return { list: dates.map((d) => ({ date: formatIsoDate(d), weekday: weekdayNameOf(d) })) };
      }

      default:
        throw new Error("不明なモードです");
    }
  }
}

/** 日付一覧をCSV（BOM付きUTF-8）としてダウンロードするためのBlobを生成する */
export function dateListToCsvBlob(list: DateListItem[]): Blob {
  const header = "日付,曜日";
  const rows = list.map((item) => `${item.date},${item.weekday}`);
  const text = "﻿" + [header, ...rows].join("\r\n");
  return new Blob([text], { type: "text/csv;charset=utf-8" });
}
