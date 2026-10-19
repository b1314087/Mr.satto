/**
 * 祝日データの「確定済みの値」と、その出典・更新日（Mr.Satto 年度カレンダー作成ツール）。
 *
 * 祝日のうち、法律で日付や週が決まっているもの（元日・成人の日・海の日など）は
 * holidays.ts のルール関数で求める。春分の日・秋分の日だけは、国立天文台の「暦要項」が
 * 前年2月に官報で公示されて初めて確定するため、公示済みの年だけをこの表に書き、
 * 公示前の年は計算式による「推定」として扱う（holidays.ts 参照）。
 *
 * ■ 毎年の更新手順（毎年2月ごろ、翌々年の暦要項が官報に公示されたあと）
 *   1. 内閣府「国民の祝日について」のページで、新しい年を含む「syukujitsu.csv」の更新を確認する。
 *      https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html
 *   2. CONFIRMED_EQUINOX_DAYS に、その年の春分・秋分の「日」を追加する。
 *   3. CONFIRMED_THROUGH_YEAR をその年に更新し、HOLIDAY_DATA_CHECKED_AT を確認した日付にする。
 *   4. tests/fixtures/static/syukujitsu.csv を新しいCSVに差し替え、tests/calendar を実行する。
 *      （CSVは内閣府の公式データで、アプリ本体には含めない。テストで祝日の計算結果と突き合わせるためだけに使う）
 */

/** 暦要項が公示済みで、祝日が確定している最後の年（西暦）。この年までの祝日は「確定」として扱う */
export const CONFIRMED_THROUGH_YEAR = 2027;

/** 上の値を最後に公式ページで確認した日 */
export const HOLIDAY_DATA_CHECKED_AT = "2026-10-19";

/** 祝日データの出典（画面・ドキュメントの表示用） */
export const HOLIDAY_DATA_SOURCES = [
  {
    label: "内閣府「国民の祝日について」",
    url: "https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html",
  },
  {
    label: "国立天文台「暦要項」",
    url: "https://www.nao.ac.jp/",
  },
] as const;

/**
 * 暦要項で公示済みの春分の日・秋分の日（日付のうちの「日」の部分）。
 * 春分は3月、秋分は9月。計算式（holidays.ts）の結果と一致していることを
 * tests/calendar/holidays-data.spec.ts で確認している。
 */
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
