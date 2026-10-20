/**
 * 祝日データ（自動生成。手で編集しない）。
 *
 * 内閣府の公式CSV（https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv）から、
 * scripts/holidays/sync.ts が検証したうえで書き換える。書き換えの方法・検証の内容は holiday-data.ts を参照。
 */

/** 暦要項が公示済みで、祝日が確定している最後の年（西暦）。この年までの祝日は「確定」として扱う */
export const CONFIRMED_THROUGH_YEAR = 2027;

/** 公式CSVの内容を最後にこのデータへ反映（確認）した日 */
export const HOLIDAY_DATA_CHECKED_AT = "2026-10-19";

/** 暦要項で公示済みの春分の日・秋分の日（日付のうちの「日」の部分）。春分は3月、秋分は9月 */
export const CONFIRMED_EQUINOX_DAYS: Readonly<Record<number, { spring: number; autumn: number }>> = {
  2020: { spring: 20, autumn: 22 },
  2021: { spring: 20, autumn: 23 },
  2022: { spring: 21, autumn: 23 },
  2023: { spring: 21, autumn: 23 },
  2024: { spring: 20, autumn: 22 },
  2025: { spring: 20, autumn: 23 },
  2026: { spring: 20, autumn: 23 },
  2027: { spring: 21, autumn: 23 },
};

export type OfficialHolidayKind = "national" | "substitute" | "citizens" | "special";

/** 公式CSVに載っている祝日 */
export interface OfficialHoliday {
  /** YYYY-MM-DD */
  iso: string;
  name: string;
  kind: OfficialHolidayKind;
}

/**
 * 公式CSVと、holidays.ts の計算ルールの結果が食い違う年の、公式の祝日一覧。
 * 祝日法の改正（祝日の新設・日付や名称の変更・廃止）があると、その年がここに入り、その年の祝日は公式の一覧そのままになる。
 * 計算ルールと一致している年は入らない（通常は空）。
 */
export const OFFICIAL_HOLIDAY_OVERRIDES: Readonly<Record<number, readonly OfficialHoliday[]>> = {};
