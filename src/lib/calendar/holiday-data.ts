/**
 * 祝日データの出典と、自動更新の仕組み（Mr.Satto 年度カレンダー作成ツール）。
 *
 * 祝日のうち、法律で日付や週が決まっているもの（元日・成人の日・海の日など）は
 * holidays.ts のルール関数で求める。春分の日・秋分の日だけは、国立天文台の「暦要項」が
 * 前年2月に官報で公示されて初めて確定するため、公示済みの年だけを表（CONFIRMED_EQUINOX_DAYS）に書き、
 * 公示前の年は計算式による「推定」として扱う（holidays.ts 参照）。
 *
 * ■ 毎年の更新は自動（人が手作業で行う必要はない）
 *   GitHub Actions（.github/workflows/sync-holidays.yml）が毎週、内閣府の公式CSVを取得し、
 *   scripts/holidays/sync.ts が次のことを行う。
 *     1. 取得・解析・検証（形式・日付・名称・件数・過去の年が変わっていないか）。通らなければ何も書き換えない。
 *     2. 公式CSVと、現在の計算ルール＋データの結果を、年ごとに突き合わせる。
 *     3. 差分があれば、holiday-data.generated.ts（公示済みの最終年・春分/秋分の確定表・年ごとの公式の祝日一覧）と、
 *        テスト用の公式CSVの控え（tests/fixtures/static/cao-syukujitsu-decoded.csv と同名の .json）を書き換える。
 *        春分・秋分以外の祝日の追加・日付や名称の変更・廃止（祝日法の改正）も、計算ルールと食い違う年は
 *        OFFICIAL_HOLIDAY_OVERRIDES に公式の一覧そのままを入れるため、プログラムの修正なしで反映される。
 *     4. 型検査と tests/calendar を実行し、通ったときだけ main へ反映する（Vercel が自動でデプロイする）。
 *   差分がなければ、何も書き換えず、コミット・デプロイも発生しない。
 *   計算ルールそのものの見直しが必要な可能性（公式CSVとルールが食い違う年がある）は、GitHub の Issue で知らせる。
 *
 * ■ 「確定」の意味（画面・Excel・PDFで共通。model.ts の monthNote 参照）
 *   CONFIRMED_THROUGH_YEAR までの年は、公式CSVに載っている日付で、すべての祝日が「確定」。
 *   それより先の年は、春分・秋分とそれに伴う休日だけが「推定」（「※」付き）で、そのほかの祝日は
 *   「法律どおり」（祝日法の現行の定めによる。法改正で変わりうる）。「※」は推定の日だけに付ける。
 */

export {
  CONFIRMED_EQUINOX_DAYS,
  CONFIRMED_THROUGH_YEAR,
  HOLIDAY_DATA_CHECKED_AT,
  OFFICIAL_HOLIDAY_OVERRIDES,
  type OfficialHoliday,
  type OfficialHolidayKind,
} from "./holiday-data.generated";

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
