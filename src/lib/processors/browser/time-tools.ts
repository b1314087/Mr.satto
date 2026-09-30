import { BrowserProcessor } from "../types";
import {
  parseTimeStr,
  toMinutesOfDay,
  formatTimeOfDay,
  minutesToDurationLabel,
  minutesToDecimalHours,
  decimalHoursToMinutes,
  diffMinutes,
} from "@/lib/time/time-utils";

/**
 * 時間計算ツール（次工程・軽量便利ツール一括追加 Tool 2）。
 * 時刻差・加算・減算・複数時間合計・実働時間（休憩差引）・時間表記変換を
 * 1つのProcessorへモード切替でまとめている。
 */
export type TimeToolMode = "diff" | "add" | "subtract" | "sum" | "work" | "convert";

export interface TimeToolInput {
  mode: TimeToolMode;
  /** diff / work モードの開始時刻（"HH:MM"） */
  start?: string;
  /** diff / work モードの終了時刻（"HH:MM"） */
  end?: string;
  /** work モードの休憩時間（分） */
  breakMinutes?: number;
  /** add / subtract モードの基準時刻（"HH:MM"） */
  base?: string;
  /** add / subtract モードで加減算する時間（分、0以上） */
  deltaMinutes?: number;
  /** sum モードで合計する時間のリスト（分） */
  durationsMinutes?: number[];
  /** convert モード: 時・分 → 小数時間 に変換する場合 */
  hours?: number;
  minutes?: number;
  /** convert モード: 小数時間 → 時・分 に変換する場合（hours/minutesより優先） */
  decimalHours?: number;
}

export interface TimeToolOutput {
  /** add / subtract モードの結果時刻 */
  resultTime?: string;
  /** diff / sum / work / convert モードの結果（分） */
  durationMinutes?: number;
  /** 「7時間30分」形式の表示ラベル */
  durationLabel?: string;
  decimalHours?: number;
  hours?: number;
  minutes?: number;
}

function requireTime(value: string | undefined, label: string) {
  const parsed = parseTimeStr(value ?? "");
  if (!parsed) throw new Error(`${label}はHH:MM形式（例: 09:00）で入力してください`);
  return parsed;
}

export class TimeToolsProcessor extends BrowserProcessor<TimeToolInput, TimeToolOutput> {
  async process(input: TimeToolInput): Promise<TimeToolOutput> {
    switch (input.mode) {
      case "diff": {
        const s = requireTime(input.start, "開始時刻");
        const e = requireTime(input.end, "終了時刻");
        const mins = diffMinutes(s, e);
        return {
          durationMinutes: mins,
          durationLabel: minutesToDurationLabel(mins),
          decimalHours: minutesToDecimalHours(mins),
        };
      }

      case "add":
      case "subtract": {
        const b = requireTime(input.base, "基準時刻");
        if (input.deltaMinutes === undefined || !Number.isFinite(input.deltaMinutes)) {
          throw new Error("加算・減算する時間を入力してください");
        }
        if (input.deltaMinutes < 0) {
          throw new Error("加算・減算する時間は0以上で入力してください");
        }
        const sign = input.mode === "add" ? 1 : -1;
        const total = toMinutesOfDay(b) + sign * input.deltaMinutes;
        return { resultTime: formatTimeOfDay(total) };
      }

      case "sum": {
        const list = input.durationsMinutes ?? [];
        if (list.length === 0) throw new Error("合計する時間を1つ以上入力してください");
        const total = list.reduce((acc, v) => acc + v, 0);
        return {
          durationMinutes: total,
          durationLabel: minutesToDurationLabel(total),
          decimalHours: minutesToDecimalHours(total),
        };
      }

      case "work": {
        const s = requireTime(input.start, "開始時刻");
        const e = requireTime(input.end, "終了時刻");
        const brk = input.breakMinutes ?? 0;
        if (brk < 0) throw new Error("休憩時間は0以上で入力してください");
        const gross = diffMinutes(s, e);
        const net = Math.max(0, gross - brk);
        return {
          durationMinutes: net,
          durationLabel: minutesToDurationLabel(net),
          decimalHours: minutesToDecimalHours(net),
        };
      }

      case "convert": {
        if (input.decimalHours !== undefined) {
          if (!Number.isFinite(input.decimalHours)) throw new Error("時間（小数）を入力してください");
          const mins = decimalHoursToMinutes(input.decimalHours);
          return {
            durationMinutes: mins,
            durationLabel: minutesToDurationLabel(mins),
            hours: Math.floor(Math.abs(mins) / 60) * Math.sign(mins || 1),
            minutes: Math.abs(mins) % 60,
            decimalHours: input.decimalHours,
          };
        }
        const h = input.hours ?? 0;
        const m = input.minutes ?? 0;
        if (m < 0 || m > 59) throw new Error("分は0〜59の範囲で入力してください");
        const mins = h * 60 + m;
        return {
          durationMinutes: mins,
          durationLabel: minutesToDurationLabel(mins),
          decimalHours: minutesToDecimalHours(mins),
          hours: h,
          minutes: m,
        };
      }

      default:
        throw new Error("不明なモードです");
    }
  }
}
