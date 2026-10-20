/**
 * 祝日データを固定する（テスト用）。
 *
 * 祝日のデータ（公示済みの最終年・春分/秋分の確定表・年ごとの公式の祝日一覧）は、内閣府の公式CSVから自動で更新される
 * （scripts/holidays）。そのため、「2027年までは確定、2028年は推定…」のような表示の仕様テストが、更新のたびに
 * 壊れないよう、仕様テストは下の固定データ（2026年10月時点の公式CSVの内容）で行う。
 * 自動更新されるデータそのものの正しさは、公式CSVとの突き合わせ（holidays-oracle.spec.ts）と、
 * 更新処理のテスト（holidays-sync.spec.ts）が確かめる。
 */
import { test } from "@playwright/test";
import { setHolidayDataForTesting, type HolidayData } from "@/lib/calendar/holidays";

/** 2026年10月時点の公式CSV（2027年まで）に基づく、固定の祝日データ */
export const HOLIDAY_DATA_PINNED: HolidayData = {
  confirmedThroughYear: 2027,
  equinoxDays: {
    2020: { spring: 20, autumn: 22 },
    2021: { spring: 20, autumn: 23 },
    2022: { spring: 21, autumn: 23 },
    2023: { spring: 21, autumn: 23 },
    2024: { spring: 20, autumn: 22 },
    2025: { spring: 20, autumn: 23 },
    2026: { spring: 20, autumn: 23 },
    2027: { spring: 21, autumn: 23 },
  },
  overrides: {},
};

/**
 * このファイル（または、呼び出した describe）のテストを、固定の祝日データで行う。
 * テストファイルの先頭（または test.describe の中）で呼ぶ。
 */
export function pinHolidayData(data: HolidayData = HOLIDAY_DATA_PINNED): void {
  test.beforeAll(() => setHolidayDataForTesting(data));
  test.afterAll(() => setHolidayDataForTesting(null));
}
