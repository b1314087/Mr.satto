import { test, expect } from "@playwright/test";
import {
  HOLIDAY_MAX_YEAR,
  HOLIDAY_MIN_YEAR,
  autumnEquinoxDay,
  getHoliday,
  getHolidays,
  springEquinoxDay,
} from "@/lib/calendar/holidays";
import {
  CONFIRMED_EQUINOX_DAYS,
  CONFIRMED_THROUGH_YEAR,
  HOLIDAY_DATA_CHECKED_AT,
} from "@/lib/calendar/holiday-data";

/**
 * 祝日ルールの個別ケース（年度カレンダー 工程A）。
 * 期待値は、祝日法・内閣府の公表内容に基づいて手で書いた値で、実装から作っていない。
 */

function nameOn(iso: string): string | undefined {
  return getHoliday(iso)?.name;
}

test.describe("祝日: 振替休日", () => {
  const cases: [string, string][] = [
    ["2023-01-02", "元日（日曜）の振替"],
    ["2024-02-12", "建国記念の日（日曜）の振替"],
    ["2024-05-06", "こどもの日（日曜）の振替"],
    ["2025-11-24", "勤労感謝の日（日曜）の振替"],
    ["2026-05-06", "憲法記念日（日曜）の振替で、5/4・5/5を飛ばした翌日"],
    ["2019-05-06", "こどもの日（日曜）の振替"],
    ["2021-08-09", "山の日（2021年は8/8の日曜）の振替"],
    ["2027-03-22", "春分の日（日曜）の振替"],
  ];
  for (const [iso, label] of cases) {
    test(`${iso} は振替休日: ${label}`, () => {
      expect(nameOn(iso)).toBe("振替休日");
    });
  }

  test("日曜でない祝日の翌日は振替休日にならない", () => {
    expect(nameOn("2026-01-13")).toBeUndefined();
    expect(nameOn("2025-04-30")).toBeUndefined();
  });

  test("2006年以前は日曜の祝日の翌日（月曜）だけが振替になる", () => {
    // 2005年5月: 5/3(火)憲法記念日、5/4(水)国民の休日、5/5(木)こどもの日。日曜の祝日はない
    expect(nameOn("2004-05-04")).toBe("国民の休日");
    // 2003年9/23(火)秋分の日。2002年9/15(日)敬老の日 → 9/16(月)が振替
    expect(nameOn("2002-09-16")).toBe("振替休日");
  });
});

test.describe("祝日: 国民の休日", () => {
  const cases: [string, string][] = [
    ["2026-09-22", "敬老の日(9/21)と秋分の日(9/23)にはさまれる"],
    ["2019-04-30", "昭和の日と即位の日にはさまれる"],
    ["2019-05-02", "即位の日と憲法記念日にはさまれる"],
    ["2009-09-22", "敬老の日(9/21)と秋分の日(9/23)にはさまれる"],
    ["2005-05-04", "2006年以前の5月4日（みどりの日になる前）"],
  ];
  for (const [iso, label] of cases) {
    test(`${iso} は国民の休日: ${label}`, () => {
      expect(nameOn(iso)).toBe("国民の休日");
    });
  }

  test("日曜は国民の休日にならない（前後が祝日でも）", () => {
    for (let y = 2000; y <= 2099; y++) {
      for (const h of getHolidays(y)) {
        if (h.kind === "citizens") {
          expect(new Date(`${h.iso}T00:00:00Z`).getUTCDay(), `${h.iso}`).not.toBe(0);
        }
      }
    }
  });
});

test.describe("祝日: 過去の特例", () => {
  test("2019年: 即位に伴う特例（4/30・5/1・5/2が連休、10/22が休日）", () => {
    expect(nameOn("2019-04-30")).toBe("国民の休日");
    expect(nameOn("2019-05-01")).toBe("即位の日");
    expect(nameOn("2019-05-02")).toBe("国民の休日");
    expect(nameOn("2019-10-22")).toBe("即位礼正殿の儀");
  });

  test("2019年: 天皇誕生日の祝日がない（12/23も2/23も休みでない）", () => {
    expect(nameOn("2019-12-23")).toBeUndefined();
    expect(nameOn("2019-02-23")).toBeUndefined();
    expect(nameOn("2018-12-23")).toBe("天皇誕生日");
    expect(nameOn("2020-02-23")).toBe("天皇誕生日");
    expect(nameOn("2020-12-23")).toBeUndefined();
  });

  test("2020年: 東京五輪に伴う海の日・スポーツの日・山の日の移動", () => {
    expect(nameOn("2020-07-23")).toBe("海の日");
    expect(nameOn("2020-07-24")).toBe("スポーツの日");
    expect(nameOn("2020-08-10")).toBe("山の日");
    expect(nameOn("2020-07-20")).toBeUndefined();
    expect(nameOn("2020-10-12")).toBeUndefined();
    expect(nameOn("2020-08-11")).toBeUndefined();
  });

  test("2021年: 海の日7/22・スポーツの日7/23・山の日8/8（8/9は振替）", () => {
    expect(nameOn("2021-07-22")).toBe("海の日");
    expect(nameOn("2021-07-23")).toBe("スポーツの日");
    expect(nameOn("2021-08-08")).toBe("山の日");
    expect(nameOn("2021-08-09")).toBe("振替休日");
    expect(nameOn("2021-07-19")).toBeUndefined();
    expect(nameOn("2021-10-11")).toBeUndefined();
  });

  test("2022年以降: スポーツの日は10月第2月曜日", () => {
    expect(nameOn("2022-10-10")).toBe("スポーツの日");
    expect(nameOn("2026-10-12")).toBe("スポーツの日");
  });

  test("名称の変更: 体育の日（〜2019年）、みどりの日（4/29は〜2006年、5/4は2007年〜）", () => {
    expect(nameOn("2019-10-14")).toBe("体育の日");
    expect(nameOn("2006-04-29")).toBe("みどりの日");
    expect(nameOn("2007-04-29")).toBe("昭和の日");
    expect(nameOn("2007-05-04")).toBe("みどりの日");
  });

  test("ハッピーマンデーの切り替え（成人の日2000年、海の日・敬老の日2003年）", () => {
    expect(nameOn("2000-01-10")).toBe("成人の日");
    expect(nameOn("2002-07-20")).toBe("海の日");
    expect(nameOn("2003-07-21")).toBe("海の日");
    expect(nameOn("2002-09-15")).toBe("敬老の日");
    expect(nameOn("2003-09-15")).toBe("敬老の日");
  });
});

test.describe("祝日: 春分・秋分", () => {
  test("公示済みの年の表は、計算式の値と食い違わない（表の入力ミスの検出）", () => {
    for (const [yearText, days] of Object.entries(CONFIRMED_EQUINOX_DAYS)) {
      const y = Number(yearText);
      const spring = Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
      const autumn = Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
      expect(days, `${y}年`).toEqual({ spring, autumn });
    }
  });

  test("2000〜2027年の春分・秋分（国立天文台の公表値）", () => {
    const spring: Record<number, number> = {
      2000: 20, 2004: 20, 2008: 20, 2012: 20, 2016: 20, 2019: 21, 2020: 20, 2021: 20, 2022: 21, 2023: 21,
      2024: 20, 2025: 20, 2026: 20, 2027: 21,
    };
    const autumn: Record<number, number> = {
      2000: 23, 2004: 23, 2008: 23, 2012: 22, 2016: 22, 2019: 23, 2020: 22, 2021: 23, 2022: 23, 2023: 23,
      2024: 22, 2025: 23, 2026: 23, 2027: 23,
    };
    for (const [y, d] of Object.entries(spring)) expect(springEquinoxDay(Number(y)).day, `春分${y}`).toBe(d);
    for (const [y, d] of Object.entries(autumn)) expect(autumnEquinoxDay(Number(y)).day, `秋分${y}`).toBe(d);
  });
});

test.describe("祝日: 確度（確定・法定・推定）", () => {
  test("公示済みの最終年と、データの確認日が設定されている", () => {
    expect(CONFIRMED_THROUGH_YEAR).toBe(2027);
    expect(HOLIDAY_DATA_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(CONFIRMED_EQUINOX_DAYS[CONFIRMED_THROUGH_YEAR]).toBeTruthy();
  });

  test("2027年までの祝日はすべて『確定』", () => {
    for (let y = 2000; y <= 2027; y++) {
      for (const h of getHolidays(y)) expect(h.status, h.iso).toBe("confirmed");
    }
  });

  test("2028年の春分・秋分は『推定』で、確定した祝日として扱わない", () => {
    expect(getHoliday("2028-03-20")).toMatchObject({ name: "春分の日", status: "estimated" });
    expect(getHoliday("2028-09-22")).toMatchObject({ name: "秋分の日", status: "estimated" });
  });

  test("2028年の元日・成人の日などは法律で決まるので『法定』", () => {
    expect(getHoliday("2028-01-01")).toMatchObject({ name: "元日", status: "statutory" });
    expect(getHoliday("2028-01-10")).toMatchObject({ name: "成人の日", status: "statutory" });
    expect(getHoliday("2028-02-23")).toMatchObject({ name: "天皇誕生日", status: "statutory" });
  });

  test("推定の秋分に付随する振替休日・国民の休日も『推定』になる", () => {
    // 2029-09-23(日)秋分 → 9/24 振替、2032-09-20(月)敬老・9/22(水)秋分 → 9/21 国民の休日
    // 2033-03-20(日)春分 → 3/21 振替
    expect(getHoliday("2029-09-24")).toMatchObject({ name: "振替休日", status: "estimated" });
    expect(getHoliday("2032-09-21")).toMatchObject({ name: "国民の休日", status: "estimated" });
    expect(getHoliday("2033-03-21")).toMatchObject({ name: "振替休日", status: "estimated" });
  });

  test("推定の秋分と無関係な振替休日は『法定』のまま", () => {
    // 2034-01-01(日)元日 → 1/2 振替（春分・秋分と無関係なので、先の年でも法律どおりに決まる）
    expect(getHoliday("2034-01-02")).toMatchObject({ name: "振替休日", status: "statutory" });
  });
});

test.describe("祝日: 入力の検証", () => {
  test("対応範囲の外（1999年・2100年・小数・NaN）はエラーにする", () => {
    for (const y of [HOLIDAY_MIN_YEAR - 1, HOLIDAY_MAX_YEAR + 1, 2026.5, Number.NaN]) {
      expect(() => getHolidays(y), String(y)).toThrow(RangeError);
    }
  });

  test("毎年の祝日は日付が重複せず、昇順に並び、その年の日付だけである", () => {
    for (let y = HOLIDAY_MIN_YEAR; y <= HOLIDAY_MAX_YEAR; y++) {
      const list = getHolidays(y);
      const isos = list.map((h) => h.iso);
      expect(new Set(isos).size, `${y}`).toBe(isos.length);
      expect([...isos].sort(), `${y}`).toEqual(isos);
      for (const iso of isos) expect(iso.startsWith(`${y}-`), iso).toBe(true);
      for (const h of list) {
        expect(h.name.length, h.iso).toBeGreaterThan(0);
      }
    }
  });
});
