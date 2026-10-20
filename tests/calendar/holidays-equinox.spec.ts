import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { fixtures } from "../fixtures/paths";
import { CONFIRMED_EQUINOX_DAYS, CONFIRMED_THROUGH_YEAR } from "@/lib/calendar/holiday-data";
import { autumnEquinoxDay, getHolidays, springEquinoxDay } from "@/lib/calendar/holidays";

/**
 * 春分の日・秋分の日を、実装の計算式とは別の方法（天文計算。Meeus法で春分点・秋分点の瞬間を求め、日本時間に直した値）と
 * 突き合わせる。python-holidays も計算式を使っているため、独立した確認としてはこちらの方が強い。
 * 期待値は tests/fixtures/static/equinox-astronomical-meeus-2000-2099.json（実装の関数からは作っていない）。
 */
const ref = JSON.parse(
  fs.readFileSync(path.join(fixtures.dir.static, "equinox-astronomical-meeus-2000-2099.json"), "utf-8"),
) as { years: Record<string, { spring: string; autumn: string }> };

const dayOf = (iso: string) => Number(iso.slice(8, 10));
/** 日本時間の0時の前後30分以内。天文計算の誤差（数分）で日付が変わりうる、判定の難しい年 */
function isFragile(iso: string): boolean {
  const minutes = Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
  return minutes < 30 || minutes > 24 * 60 - 30;
}

test.describe("春分の日・秋分の日: 天文計算との突き合わせ", () => {
  test("2000〜2099年の春分・秋分200日が、天文計算の日付と一致する", () => {
    const diffs: string[] = [];
    for (let y = 2000; y <= 2099; y++) {
      const r = ref.years[String(y)];
      if (springEquinoxDay(y).day !== dayOf(r.spring)) diffs.push(`${y}春分: 実装=${springEquinoxDay(y).day} 天文=${r.spring}`);
      if (autumnEquinoxDay(y).day !== dayOf(r.autumn)) diffs.push(`${y}秋分: 実装=${autumnEquinoxDay(y).day} 天文=${r.autumn}`);
    }
    expect(diffs).toEqual([]);
  });

  test("暦要項で公示済みの表（2020〜2027年）も、天文計算と一致する", () => {
    for (const [ys, v] of Object.entries(CONFIRMED_EQUINOX_DAYS)) {
      const r = ref.years[ys];
      expect({ y: ys, spring: v.spring, autumn: v.autumn }).toEqual({ y: ys, spring: dayOf(r.spring), autumn: dayOf(r.autumn) });
    }
  });

  test("公示済みの年より先で、天文計算でも日付が変わりうる年（0時の前後30分）は、すべて『推定』扱いになっている", () => {
    const fragile: string[] = [];
    for (let y = 2000; y <= 2099; y++) {
      const r = ref.years[String(y)];
      for (const [kind, iso] of [["春分", r.spring], ["秋分", r.autumn]] as const) {
        if (!isFragile(iso)) continue;
        fragile.push(`${y}${kind}`);
        const est = (kind === "春分" ? springEquinoxDay(y) : autumnEquinoxDay(y)).estimated;
        expect(est, `${y}${kind}`).toBe(y > CONFIRMED_THROUGH_YEAR);
        if (y > CONFIRMED_THROUGH_YEAR) {
          const h = getHolidays(y).find((x) => x.name === (kind === "春分" ? "春分の日" : "秋分の日"));
          expect(h?.status, `${y}${kind}`).toBe("estimated");
        }
      }
    }
    // 該当年が増減したら（元データ・計算方法を変えたら）気づけるよう、件数を固定する
    expect(fragile).toEqual([
      "2012秋分", "2026春分", "2041秋分", "2045秋分", "2055春分", "2059春分", "2074秋分", "2088春分", "2092春分",
    ]);
  });
});
