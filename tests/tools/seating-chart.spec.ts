import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { buildMinimalXlsx } from "../fixtures/xlsx-writer";
import { assertDownloadedFile, clickAndDownload } from "../helpers/tool-runner";
import { uploadWhenReady } from "../helpers/tool-ready";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import {
  EMPTY_CONSTRAINTS,
  arrangeSeating,
  evaluateConstraints,
  parseRuleNames,
  swapSeats,
  validatePlan,
  type SeatingConstraints,
  type SeatingSetup,
} from "@/lib/seating/arrange";
import { SEATING_MAX_PARTICIPANTS, namesFromRows, parseParticipants, type Participant } from "@/lib/seating/participants";
import { seatingGridRows, seatingList, seatingToCsvBlob } from "@/lib/processors/browser/seating-export";

/**
 * 座席表作成（seating-chart）のテスト。
 * 1. 参加者の読み取り・席順の自動作成・条件・手動の入れ替えの規則（純粋な関数）の単体テスト
 * 2. 実際に名簿を入れて席順を作り、手で入れ替え、PDF・Excel・CSVを保存して、内容を確認する画面テスト
 * 3. 席数の不足・条件の衝突の説明と、名前が外部へ送信されないことの確認
 */

const people = (names: string[]): Participant[] => names.map((name, id) => ({ id, name }));
const setup = (sizes: number[], balance: SeatingSetup["balance"] = "even"): SeatingSetup => ({ tableSizes: sizes, balance });
const cons = (c: Partial<SeatingConstraints>): SeatingConstraints => ({ ...EMPTY_CONSTRAINTS, ...c });

function tableOf(plan: { tables: (number | null)[][] }, id: number): number {
  return plan.tables.findIndex((row) => row.includes(id));
}

// ---------------------------------------------------------------------------
// 1. 規則（単体）
// ---------------------------------------------------------------------------
plainTest.describe("seating-chart: 参加者の読み取り", () => {
  plainTest("改行・タブ・「、」「,」で区切り、空の項目は数えて除く。名前の中の空白では区切らない", () => {
    const r = parseParticipants("山田 太郎\n\n 佐藤　花子 \n鈴木一郎、高橋次郎,田中三郎\t小林四郎\n   \n");
    plainExpect(r.participants.map((p) => p.name)).toEqual(["山田 太郎", "佐藤 花子", "鈴木一郎", "高橋次郎", "田中三郎", "小林四郎"]);
    plainExpect(r.participants.map((p) => p.id)).toEqual([0, 1, 2, 3, 4, 5]);
    plainExpect(r.blankCount).toBe(3);
  });

  plainTest("同じ名前（全角・半角・空白の違いを無視）は、既定では2人目以降を除き、除いた名前を示す", () => {
    const r = parseParticipants("山田 太郎\n山田太郎\nＡＢＣ\nabc\n佐藤");
    plainExpect(r.participants.map((p) => p.name)).toEqual(["山田 太郎", "ＡＢＣ", "佐藤"]);
    plainExpect(r.removedDuplicates).toEqual(["山田太郎", "abc"]);
  });

  plainTest("「同じ名前も別の人」を選ぶと、番号を付けて全員を残す（番号付きの名前が既にあっても、重ならない）", () => {
    const r = parseParticipants("山田太郎\n山田太郎\n山田太郎(2)\n山田太郎", { keepDuplicates: true });
    const names = r.participants.map((p) => p.name);
    plainExpect(names).toHaveLength(4);
    plainExpect(new Set(names.map((n) => n.normalize("NFKC"))).size).toBe(4);
    plainExpect(names[0]).toBe("山田太郎");
    plainExpect(r.renamedDuplicates.length).toBe(3);
  });

  plainTest("人数の上限を超えた分は読み込まず、人数を数える", () => {
    const text = Array.from({ length: SEATING_MAX_PARTICIPANTS + 3 }, (_, i) => `人${i}`).join("\n");
    const r = parseParticipants(text);
    plainExpect(r.participants).toHaveLength(SEATING_MAX_PARTICIPANTS);
    plainExpect(r.overLimit).toBe(3);
  });

  plainTest("表から名前の列を取り出す: 見出し（氏名など）があればその列、無ければ1列目", () => {
    plainExpect(namesFromRows([["No", "氏名", "部署"], [1, "山田", "営業"], [2, "佐藤", "総務"]])).toEqual({ names: ["山田", "佐藤"], column: 1, hadHeader: true });
    plainExpect(namesFromRows([[null, null], ["山田"], ["佐藤"]])).toEqual({ names: ["山田", "佐藤"], column: 0, hadHeader: false });
    plainExpect(namesFromRows([[], [null]]).names).toEqual([]);
  });

  plainTest("条件の欄の名前は、区切り文字で分け、名前の中の空白では分けない", () => {
    plainExpect(parseRuleNames("山田 太郎、佐藤花子, 鈴木 一郎;高橋/田中\n小林")).toEqual(["山田 太郎", "佐藤花子", "鈴木 一郎", "高橋", "田中", "小林"]);
  });
});

plainTest.describe("seating-chart: 席順の自動作成", () => {
  const names = Array.from({ length: 10 }, (_, i) => `参加者${i + 1}`);
  const ps = people(names);

  plainTest("全員が1回ずつ席に入り、席数を超えない（重複・欠落なし）。同じ番号なら同じ結果、番号が違えば別の結果", () => {
    const sizes = [4, 4, 4];
    const results = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const r = arrangeSeating(ps, setup(sizes), EMPTY_CONSTRAINTS, seed);
      if (!r.ok) throw new Error("配置できるはずです");
      plainExpect(validatePlan(r.plan, ps, sizes)).toEqual([]);
      r.plan.tables.forEach((row, t) => plainExpect(row).toHaveLength(sizes[t]));
      results.add(JSON.stringify(r.plan));
      const again = arrangeSeating(ps, setup(sizes), EMPTY_CONSTRAINTS, seed);
      plainExpect(again.ok && JSON.stringify(again.plan)).toBe(JSON.stringify(r.plan));
    }
    plainExpect(results.size).toBeGreaterThan(20);
  });

  plainTest("「均等」は各テーブルの人数の差が1人以内、「前から詰める」は前のテーブルから埋まる。空席は各テーブルの後ろに寄る", () => {
    const even = arrangeSeating(ps, setup([4, 4, 4], "even"), EMPTY_CONSTRAINTS, 5);
    const fill = arrangeSeating(ps, setup([4, 4, 4], "fill"), EMPTY_CONSTRAINTS, 5);
    if (!even.ok || !fill.ok) throw new Error("配置できるはずです");
    const count = (row: (number | null)[]) => row.filter((v) => v !== null).length;
    const evenCounts = even.plan.tables.map(count);
    plainExpect(Math.max(...evenCounts) - Math.min(...evenCounts)).toBeLessThanOrEqual(1);
    plainExpect(fill.plan.tables.map(count)).toEqual([4, 4, 2]);
    for (const row of [...even.plan.tables, ...fill.plan.tables]) {
      const firstEmpty = row.indexOf(null);
      if (firstEmpty >= 0) plainExpect(row.slice(firstEmpty).every((v) => v === null)).toBe(true);
    }
  });

  plainTest("テーブルごとに席数が違っても、その席数の範囲で配置する", () => {
    const sizes = [2, 6, 3];
    const r = arrangeSeating(people(names.slice(0, 9)), setup(sizes), EMPTY_CONSTRAINTS, 3);
    if (!r.ok) throw new Error("配置できるはずです");
    plainExpect(validatePlan(r.plan, people(names.slice(0, 9)), sizes)).toEqual([]);
    plainExpect(r.plan.tables.map((row) => row.filter((v) => v !== null).length).reduce((a, b) => a + b, 0)).toBe(9);
  });

  plainTest("席数が足りないときは配置せず、何席足りないかを示す", () => {
    const r = arrangeSeating(people(Array.from({ length: 13 }, (_, i) => `P${i}`)), setup([4, 4, 4]), EMPTY_CONSTRAINTS, 1);
    plainExpect(r.ok).toBe(false);
    if (r.ok || r.reason !== "shortage") throw new Error("不足と判定されるはずです");
    plainExpect(r.shortBy).toBe(1);
    plainExpect(r.seats).toBe(12);
    plainExpect(r.message).toContain("あと1席");
  });

  plainTest("参加者がいない・席の設定が不正なときは、配置せず理由を示す", () => {
    plainExpect(arrangeSeating([], setup([4]), EMPTY_CONSTRAINTS, 1)).toMatchObject({ ok: false, reason: "invalid" });
    plainExpect(arrangeSeating(ps, setup([]), EMPTY_CONSTRAINTS, 1)).toMatchObject({ ok: false, reason: "invalid" });
    plainExpect(arrangeSeating(ps, setup([4, 0]), EMPTY_CONSTRAINTS, 1)).toMatchObject({ ok: false, reason: "invalid" });
  });

  plainTest("条件のない人の配置は公平: 6人・2テーブルで、各人が1番のテーブルになる割合は、どの人もほぼ半分", () => {
    const six = people(["A", "B", "C", "D", "E", "F"]);
    const hits = new Array<number>(6).fill(0);
    const N = 1200;
    for (let seed = 1; seed <= N; seed++) {
      const r = arrangeSeating(six, setup([3, 3]), EMPTY_CONSTRAINTS, seed * 7919);
      if (!r.ok) throw new Error("配置できるはずです");
      for (const id of r.plan.tables[0]) if (id !== null) hits[id]++;
    }
    for (const h of hits) {
      plainExpect(h / N).toBeGreaterThan(0.43);
      plainExpect(h / N).toBeLessThan(0.57);
    }
  });
});

plainTest.describe("seating-chart: 条件付き配置", () => {
  const names = Array.from({ length: 12 }, (_, i) => `参加者${i + 1}`);
  const ps = people(names);

  plainTest("同じテーブルにしたい人は、どの番号でも同じテーブルになる（複数の条件が連なっても、1つのまとまりになる）", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = arrangeSeating(ps, setup([4, 4, 4]), cons({ together: [["参加者1", "参加者2"], ["参加者2", "参加者3"]] }), seed);
      if (!r.ok) throw new Error("配置できるはずです");
      plainExpect(tableOf(r.plan, 1)).toBe(tableOf(r.plan, 0));
      plainExpect(tableOf(r.plan, 2)).toBe(tableOf(r.plan, 0));
      plainExpect(evaluateConstraints(r.plan, ps, cons({ together: [["参加者1", "参加者2"], ["参加者2", "参加者3"]] }))).toEqual([]);
    }
  });

  plainTest("別々にしたい人は、全員が互いに別のテーブルになる。名前の全角・半角・空白の違いは無視して照合する", () => {
    const c = cons({ apart: [["参加者１", "参加者 2", "参加者3"]] });
    for (let seed = 1; seed <= 60; seed++) {
      const r = arrangeSeating(ps, setup([4, 4, 4]), c, seed);
      if (!r.ok) throw new Error("配置できるはずです");
      plainExpect(new Set([tableOf(r.plan, 0), tableOf(r.plan, 1), tableOf(r.plan, 2)]).size).toBe(3);
    }
  });

  plainTest("固定: テーブル・席が指定どおりになる。同席の人は固定したテーブルへ一緒に入る", () => {
    const c = cons({
      fixed: [{ name: "参加者5", table: 3, seat: 2 }, { name: "参加者6", table: 1 }],
      together: [["参加者6", "参加者7"]],
    });
    for (let seed = 1; seed <= 40; seed++) {
      const r = arrangeSeating(ps, setup([4, 4, 4]), c, seed);
      if (!r.ok) throw new Error("配置できるはずです");
      plainExpect(r.plan.tables[2][1]).toBe(4);
      plainExpect(tableOf(r.plan, 5)).toBe(0);
      plainExpect(tableOf(r.plan, 6)).toBe(0);
      plainExpect(validatePlan(r.plan, ps, [4, 4, 4])).toEqual([]);
    }
  });

  plainTest("3つの条件を同時に満たす（同席＋別席＋固定）", () => {
    const c = cons({
      together: [["参加者1", "参加者2"], ["参加者3", "参加者4"]],
      apart: [["参加者1", "参加者3", "参加者5"]],
      fixed: [{ name: "参加者5", table: 2 }],
    });
    for (let seed = 1; seed <= 60; seed++) {
      const r = arrangeSeating(ps, setup([4, 4, 4]), c, seed);
      if (!r.ok) throw new Error("配置できるはずです");
      plainExpect(evaluateConstraints(r.plan, ps, c)).toEqual([]);
      plainExpect(tableOf(r.plan, 4)).toBe(1);
    }
  });

  plainTest("矛盾する条件は、配置せずに、衝突している理由を説明する", () => {
    const msgs = (r: ReturnType<typeof arrangeSeating>) => (r.ok ? [] : "messages" in r ? r.messages : [r.message]).join("\n");

    // 同じテーブルと別々の、両方に入っている
    const a = arrangeSeating(ps, setup([4, 4, 4]), cons({ together: [["参加者1", "参加者2"]], apart: [["参加者1", "参加者2"]] }), 1);
    plainExpect(a).toMatchObject({ ok: false, reason: "conflict" });
    plainExpect(msgs(a)).toContain("同じテーブルにしたい条件と、別々にしたい条件の両方");

    // 同じテーブルにしたい人が、席数に入らない
    const b = arrangeSeating(ps, setup([4, 4, 4]), cons({ together: [["参加者1", "参加者2", "参加者3", "参加者4", "参加者5"]] }), 1);
    plainExpect(msgs(b)).toContain("5人");
    plainExpect(msgs(b)).toContain("4席");

    // 別々にしたい人数が、テーブル数より多い
    const c = arrangeSeating(ps, setup([4, 4, 4]), cons({ apart: [["参加者1", "参加者2", "参加者3", "参加者4"]] }), 1);
    plainExpect(msgs(c)).toContain("4つのテーブルが必要");
    plainExpect(msgs(c)).toContain("テーブルは3つ");

    // 同じテーブルにしたい人が、別々のテーブルに固定されている
    const d = arrangeSeating(ps, setup([4, 4, 4]), cons({ together: [["参加者1", "参加者2"]], fixed: [{ name: "参加者1", table: 1 }, { name: "参加者2", table: 2 }] }), 1);
    plainExpect(msgs(d)).toContain("テーブル1とテーブル2に固定");

    // 別々にしたい2人が、同じテーブルに固定されている
    const e = arrangeSeating(ps, setup([4, 4, 4]), cons({ apart: [["参加者1", "参加者2"]], fixed: [{ name: "参加者1", table: 3 }, { name: "参加者2", table: 3 }] }), 1);
    plainExpect(msgs(e)).toContain("どちらもテーブル3に固定");

    // 同じ席に2人を固定
    const f = arrangeSeating(ps, setup([4, 4, 4]), cons({ fixed: [{ name: "参加者1", table: 1, seat: 1 }, { name: "参加者2", table: 1, seat: 1 }] }), 1);
    plainExpect(msgs(f)).toContain("テーブル1の席1に固定");

    // 固定したテーブルの席数を超える
    const g = arrangeSeating(
      people(["A", "B", "C", "D"]),
      setup([2, 4]),
      cons({ fixed: [{ name: "A", table: 1 }], together: [["A", "B", "C"]] }),
      1
    );
    plainExpect(msgs(g)).toContain("席数（2席）を超えて");
  });

  plainTest("名簿にない名前・範囲外の固定は、条件を無視せず、配置せずに指摘する", () => {
    const a = arrangeSeating(ps, setup([4, 4, 4]), cons({ together: [["参加者1", "存在しない人"]] }), 1);
    plainExpect(a).toMatchObject({ ok: false, reason: "invalid" });
    if (!a.ok && a.reason === "invalid") plainExpect(a.messages.join("")).toContain("「存在しない人」は参加者の名簿にありません");
    const b = arrangeSeating(ps, setup([4, 4, 4]), cons({ fixed: [{ name: "参加者1", table: 9 }] }), 1);
    plainExpect(b).toMatchObject({ ok: false, reason: "invalid" });
    const c = arrangeSeating(ps, setup([4, 4, 4]), cons({ fixed: [{ name: "参加者1", table: 1, seat: 5 }] }), 1);
    plainExpect(c).toMatchObject({ ok: false, reason: "invalid" });
  });

  plainTest("席数に収まる組み合わせが無いときは、成功と見せず、置けなかった例を示す", () => {
    const six = people(["A", "B", "C", "D", "E", "F"]);
    const r = arrangeSeating(six, setup([3, 3]), cons({ together: [["A", "B"], ["C", "D"], ["E", "F"]] }), 1);
    plainExpect(r.ok).toBe(false);
    if (r.ok || r.reason !== "conflict") throw new Error("衝突と判定されるはずです");
    plainExpect(r.messages.join("\n")).toContain("見つかりませんでした");
    plainExpect(r.messages.join("\n")).toContain("例:");
  });
});

plainTest.describe("seating-chart: 手動の入れ替えと、条件の確認", () => {
  const ps = people(["A", "B", "C", "D", "E"]);
  const sizes = [3, 3];
  const base = { tables: [[0, 1, 2], [3, 4, null]] };

  plainTest("席の入れ替え・空席への移動をしても、重複・欠落が起きない。元の席順は書き換えない", () => {
    const swapped = swapSeats(base, { table: 0, seat: 0 }, { table: 1, seat: 1 });
    plainExpect(swapped.tables).toEqual([[4, 1, 2], [3, 0, null]]);
    plainExpect(validatePlan(swapped, ps, sizes)).toEqual([]);
    const moved = swapSeats(base, { table: 0, seat: 2 }, { table: 1, seat: 2 });
    plainExpect(moved.tables).toEqual([[0, 1, null], [3, 4, 2]]);
    plainExpect(validatePlan(moved, ps, sizes)).toEqual([]);
    plainExpect(base.tables).toEqual([[0, 1, 2], [3, 4, null]]);
    plainExpect(swapSeats(base, { table: 0, seat: 0 }, { table: 5, seat: 0 })).toBe(base);
  });

  plainTest("席順の確認は、重複・欠落・席数の食い違いを見つけて説明する", () => {
    plainExpect(validatePlan({ tables: [[0, 0, 2], [3, 4, null]] }, ps, sizes).join("")).toContain("2つの席に入っています");
    plainExpect(validatePlan({ tables: [[0, 1, null], [3, 4, null]] }, ps, sizes).join("")).toContain("「C」の席がありません");
    plainExpect(validatePlan({ tables: [[0, 1], [2, 3, 4]] }, ps, sizes).join("")).toContain("席数が設定と違います");
  });

  plainTest("手で入れ替えて条件が守られなくなったら、守られていない条件を示す", () => {
    const c = cons({ together: [["A", "B"]], apart: [["A", "D"]], fixed: [{ name: "C", table: 1, seat: 3 }] });
    plainExpect(evaluateConstraints(base, ps, c)).toEqual([expect.stringContaining("別々にしたい")].map(() => expect.anything()).slice(0, 0));
    const broken = swapSeats(swapSeats(base, { table: 0, seat: 1 }, { table: 1, seat: 0 }), { table: 0, seat: 2 }, { table: 0, seat: 0 });
    const out = evaluateConstraints(broken, ps, c).join("\n");
    plainExpect(out).toContain("同じテーブルにしたい");
    plainExpect(out).toContain("固定する条件");
  });
});

plainTest.describe("seating-chart: 出力の内容", () => {
  const ps = people(["山田太郎", "=SUM(1)", "佐藤花子"]);
  const plan = { tables: [[0, 1], [2, null]] };

  plainTest("一覧・座席表シート・CSVに、席の内容が入る。CSVの数式の形の名前は、数式として実行されないようにする", async () => {
    plainExpect(seatingList({ participants: ps, plan })).toEqual([
      { name: "山田太郎", table: 1, seat: 1 },
      { name: "=SUM(1)", table: 1, seat: 2 },
      { name: "佐藤花子", table: 2, seat: 1 },
    ]);
    const grid = seatingGridRows({ title: "t", participants: ps, plan }, 2);
    plainExpect(grid[0]).toEqual(["テーブル1", null, null, "テーブル2", null, null]);
    plainExpect(grid[1]).toEqual([1, "山田太郎", null, 1, "佐藤花子", null]);
    plainExpect(grid[2]).toEqual([2, "=SUM(1)", null, 2, "（空席）", null]);
    const csv = (await seatingToCsvBlob({ title: "t", participants: ps, plan }).text()).replace(/^﻿/, "").split(/\r\n/);
    plainExpect(csv).toEqual(["氏名,テーブル,席番号", "山田太郎,1,1", "'=SUM(1),1,2", "佐藤花子,2,1"]);
  });
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------
let dir: string;
const files: Record<string, string> = {};

test.beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "seating-"));
  files.csv = path.join(dir, "roster.csv");
  fs.writeFileSync(files.csv, "No,氏名,部署\n1,CSV一郎,営業\n2,CSV二郎,総務\n\n3,CSV三郎,開発\n", "utf8");
  files.xlsx = path.join(dir, "roster.xlsx");
  fs.writeFileSync(
    files.xlsx,
    Buffer.from(buildMinimalXlsx([{ name: "名簿", rows: [[{ value: "名前" }], [{ value: "Excel花子" }], [{ value: "Excel月子" }]] }]))
  );
  files.legacy = path.join(dir, "old.xls");
  fs.writeFileSync(files.legacy, "dummy");
});

test.afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const NAMES12 = ["秘密太郎", "佐藤花子", "鈴木一郎", "高橋次郎", "田中三郎", "小林四郎", "伊藤五郎", "渡辺六子", "山本七子", "中村八郎", "加藤九子", "吉田十郎"];

async function openTool(page: Page) {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/tools/seating-chart");
  await expect(page.getByTestId("seating-names")).toBeVisible();
  // Reactの準備(hydration)が終わってから操作する（開発サーバーの初回表示直後は入力が無視されることがある）
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="seating-names"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
}

async function fillNames(page: Page, names: string[]) {
  await page.getByTestId("seating-names").fill(names.join("\n"));
}

async function setNumber(page: Page, label: string, value: number) {
  await page.getByLabel(label, { exact: true }).fill(String(value));
}

async function readSeats(page: Page): Promise<{ table: number; seat: number; name: string }[]> {
  return page.getByTestId("seating-seat").evaluateAll((els) =>
    els.map((el) => ({
      table: Number((el as HTMLElement).dataset.table),
      seat: Number((el as HTMLElement).dataset.seat),
      name: (el.querySelector("span:last-child")?.textContent ?? "").trim(),
    }))
  );
}

function tableMap(seats: { table: number; name: string }[]): Map<string, number> {
  return new Map(seats.filter((s) => s.name !== "（空席）").map((s) => [s.name, s.table]));
}

test("seating-chart: 名前を入力して席順を作ると、全員が1回ずつ席に入り、席数・空席が表示される", async ({ page }) => {
  await openTool(page);
  await fillNames(page, NAMES12.slice(0, 10));
  await expect(page.getByTestId("seating-participant-summary")).toContainText("参加者：10人");
  await setNumber(page, "テーブル数", 3);
  await setNumber(page, "1テーブルの席数", 4);
  await expect(page.getByTestId("seating-capacity")).toContainText("席は全部で12席、参加者は10人です（空席 2 席）");
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(3);
  const seats = await readSeats(page);
  expect(seats).toHaveLength(12);
  const placed = seats.map((s) => s.name).filter((n) => n !== "（空席）");
  expect([...placed].sort()).toEqual([...NAMES12.slice(0, 10)].sort());
  expect(seats.filter((s) => s.name === "（空席）")).toHaveLength(2);
});

test("seating-chart: 空行・重複した名前・区切り文字を扱い、重複は除くか、別の人として残せる", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("seating-names").fill("山田 太郎\n\n山田太郎\n佐藤花子、鈴木一郎,高橋次郎\n\n");
  await expect(page.getByTestId("seating-participant-summary")).toContainText("参加者：4人");
  await expect(page.getByTestId("seating-participant-summary")).toContainText("空の行");
  await expect(page.getByTestId("seating-participant-summary")).toContainText("同じ名前 1 件を除きました");
  await page.getByLabel(/同じ名前も別の人として扱う/).check();
  await expect(page.getByTestId("seating-participant-summary")).toContainText("参加者：5人");
  await expect(page.getByTestId("seating-participant-summary")).toContainText("山田太郎(2)");
});

test("seating-chart: CSV・Excelの名簿を読み込める（見出しがあればその列。.xlsは案内する）", async ({ page }) => {
  await openTool(page);
  await uploadWhenReady(page, [files.csv], page.getByTestId("seating-upload-note"), { readyTimeoutMs: 40_000 });
  await expect(page.getByTestId("seating-upload-note")).toContainText("「氏名」の列の3件");
  await expect(page.getByTestId("seating-names")).toHaveValue("CSV一郎\nCSV二郎\nCSV三郎");
  // 続けてExcelを読み込むと、名簿に追加される
  await page.locator('input[type="file"]').first().setInputFiles(files.xlsx);
  await expect(page.getByTestId("seating-participant-summary")).toContainText("参加者：5人", { timeout: 20_000 });
  await expect(page.getByTestId("seating-names")).toHaveValue(/Excel花子\nExcel月子$/);
  // 古い形式
  await page.locator('input[type="file"]').first().setInputFiles(files.legacy);
  await expect(page.getByText("古い形式（.xls）は読み込めません")).toBeVisible();
  await expect(page.getByTestId("seating-participant-summary")).toContainText("参加者：5人");
});

test("seating-chart: 席が足りないときは警告に何席足りないかを出し、席順は作られない", async ({ page }) => {
  await openTool(page);
  await fillNames(page, NAMES12);
  await setNumber(page, "テーブル数", 2);
  await setNumber(page, "1テーブルの席数", 5);
  await expect(page.getByTestId("seating-shortage")).toContainText("あと2席必要です");
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-errors")).toContainText("あと2席必要です");
  await expect(page.getByTestId("seating-table")).toHaveCount(0);
  // 席数を増やすと警告が消え、席順を作れる
  await setNumber(page, "1テーブルの席数", 6);
  await expect(page.getByTestId("seating-shortage")).toHaveCount(0);
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(2);
  await expect(page.getByTestId("seating-errors")).toHaveCount(0);
});

test("seating-chart: 同じテーブル・別々のテーブル・固定の条件が、再抽選を重ねても毎回守られる", async ({ page }) => {
  await openTool(page);
  await fillNames(page, NAMES12);
  await setNumber(page, "テーブル数", 3);
  await setNumber(page, "1テーブルの席数", 4);
  await page.getByRole("button", { name: "同じテーブルにしたい人を追加" }).click();
  await page.getByTestId("seating-together").first().fill("佐藤花子、鈴木一郎");
  await page.getByRole("button", { name: "別々にしたい人を追加" }).click();
  await page.getByTestId("seating-apart").first().fill("高橋次郎、田中三郎、小林四郎");
  await page.getByRole("button", { name: "席を固定する人を追加" }).click();
  await page.getByLabel("固定する人1の名前").fill("伊藤五郎");
  await page.getByLabel("固定する人1のテーブル番号").fill("3");
  await page.getByLabel("固定する人1の席番号").fill("2");

  for (let i = 0; i < 6; i++) {
    await page.getByTestId("seating-arrange").click();
    await expect(page.getByTestId("seating-table")).toHaveCount(3);
    const seats = await readSeats(page);
    const map = tableMap(seats);
    expect(map.size).toBe(12);
    expect(map.get("佐藤花子")).toBe(map.get("鈴木一郎"));
    expect(new Set([map.get("高橋次郎"), map.get("田中三郎"), map.get("小林四郎")]).size).toBe(3);
    expect(seats.find((s) => s.name === "伊藤五郎")).toMatchObject({ table: 3, seat: 2 });
    await expect(page.getByTestId("seating-violations")).toHaveCount(0);
  }
});

test("seating-chart: 条件が矛盾するときは、成功と見せず、衝突している条件を説明する。条件を直すと作れる", async ({ page }) => {
  await openTool(page);
  await fillNames(page, NAMES12);
  await setNumber(page, "テーブル数", 3);
  await setNumber(page, "1テーブルの席数", 4);
  await page.getByRole("button", { name: "同じテーブルにしたい人を追加" }).click();
  await page.getByTestId("seating-together").first().fill("佐藤花子、鈴木一郎");
  await page.getByRole("button", { name: "別々にしたい人を追加" }).click();
  await page.getByTestId("seating-apart").first().fill("鈴木一郎、佐藤花子");
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-errors")).toContainText("同じテーブルにしたい条件と、別々にしたい条件の両方");
  await expect(page.getByTestId("seating-errors")).toContainText("佐藤花子");
  await expect(page.getByTestId("seating-table")).toHaveCount(0);

  // 名簿にない名前
  await page.getByTestId("seating-apart").first().fill("鈴木一郎、存在しない人");
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-errors")).toContainText("「存在しない人」は参加者の名簿にありません");

  // 直すと作れる
  await page.getByTestId("seating-apart").first().fill("鈴木一郎、高橋次郎");
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(3);
  await expect(page.getByTestId("seating-errors")).toHaveCount(0);
});

test("seating-chart: 手で席を入れ替えられ、条件が崩れたら注意が出る。再抽選の前に、消える旨を確認する", async ({ page }) => {
  await openTool(page);
  await fillNames(page, NAMES12.slice(0, 6));
  await setNumber(page, "テーブル数", 2);
  await setNumber(page, "1テーブルの席数", 4);
  await page.getByRole("button", { name: "同じテーブルにしたい人を追加" }).click();
  await page.getByTestId("seating-together").first().fill("佐藤花子、鈴木一郎");
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(2);
  await expect(page.getByTestId("seating-edited")).toHaveCount(0);

  // 佐藤花子と、別のテーブルの人を入れ替える（空席への移動も同じ操作）
  const before = tableMap(await readSeats(page));
  const other = NAMES12.slice(0, 6).find((n) => n !== "佐藤花子" && n !== "鈴木一郎" && before.get(n) !== before.get("佐藤花子"))!;
  expect(other).toBeTruthy();
  await page.getByRole("button", { name: new RegExp(`席\\d+ 佐藤花子$`) }).click();
  await expect(page.getByRole("button", { name: new RegExp(`席\\d+ 佐藤花子$`) })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: new RegExp(`席\\d+ ${other}$`) }).click();

  const after = await readSeats(page);
  const afterMap = tableMap(after);
  expect(afterMap.get("佐藤花子")).toBe(before.get(other));
  expect(afterMap.get(other)).toBe(before.get("佐藤花子"));
  // 重複・欠落なし
  expect([...afterMap.keys()].sort()).toEqual([...NAMES12.slice(0, 6)].sort());
  await expect(page.getByTestId("seating-edited")).toBeVisible();
  await expect(page.getByTestId("seating-violations")).toContainText("同じテーブルにしたい");

  // 再抽選は、確認してから
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-confirm-redraw")).toBeVisible();
  await page.getByRole("button", { name: "やめる" }).click();
  await expect(page.getByTestId("seating-confirm-redraw")).toHaveCount(0);
  expect(tableMap(await readSeats(page)).get("佐藤花子")).toBe(afterMap.get("佐藤花子"));
  await page.getByTestId("seating-arrange").click();
  await page.getByRole("button", { name: "再抽選する", exact: true }).click();
  await expect(page.getByTestId("seating-edited")).toHaveCount(0);
  await expect(page.getByTestId("seating-violations")).toHaveCount(0);
});

test("seating-chart: 名簿を変えると、席順が古い内容であることを知らせる（席順は変えない）", async ({ page }) => {
  await openTool(page);
  await fillNames(page, NAMES12.slice(0, 4));
  await setNumber(page, "テーブル数", 2);
  await setNumber(page, "1テーブルの席数", 3);
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(2);
  await expect(page.getByTestId("seating-stale")).toHaveCount(0);
  const before = await readSeats(page);
  await fillNames(page, NAMES12.slice(0, 5));
  await expect(page.getByTestId("seating-stale")).toBeVisible();
  expect(await readSeats(page)).toEqual(before);
});

test("seating-chart: PDF・Excel・CSVで保存でき、内容は画面の席順と一致する。名前は外部に送信されない", async ({ page, baseURL }) => {
  const recorder = new NetworkRecorder(page);
  await openTool(page);
  await fillNames(page, NAMES12.slice(0, 10));
  await setNumber(page, "テーブル数", 3);
  await setNumber(page, "1テーブルの席数", 4);
  await page.getByRole("textbox", { name: "タイトル" }).count();
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(3);
  await page.getByLabel(/タイトル（PDF/).fill("忘年会 座席表");
  const seats = await readSeats(page);

  // PDF
  const pdfDownload = await clickAndDownload(page, "PDFでダウンロード");
  expect(pdfDownload.suggestedFilename()).toBe("忘年会 座席表.pdf");
  const { path: pdfPath } = await assertDownloadedFile(pdfDownload, { format: "pdf", minBytes: 1000 });
  expect(isValidPdfFile(pdfPath)).toBe(true);
  const pdf = await extractPdfContent(pdfPath);
  expect(pdf.pageCount).toBeGreaterThanOrEqual(1);
  expect(pdf.pages[0].width).toBeCloseTo(841.89, 0); // A4横
  const pdfText = pdf.text.replace(/\s+/g, "");
  expect(pdfText).toContain("忘年会座席表");
  for (const t of [1, 2, 3]) expect(pdfText).toContain(`テーブル${t}`);
  for (const n of NAMES12.slice(0, 10)) expect(pdfText, `PDFに「${n}」がありません`).toContain(n);
  expect(pdfText).toContain("（空席）");

  // Excel
  const xlsxDownload = await clickAndDownload(page, "Excelでダウンロード");
  expect(xlsxDownload.suggestedFilename()).toBe("忘年会 座席表.xlsx");
  const { path: xlsxPath } = await assertDownloadedFile(xlsxDownload, { format: "zip", minBytes: 500 });
  const grid = await readXlsxSheet(xlsxPath);
  expect(grid.headers.filter((h) => h !== "")).toEqual(["テーブル1", "テーブル2", "テーブル3"]);
  const gridNames = grid.rows.flatMap((r) => r.filter((v): v is string => typeof v === "string"));
  for (const n of NAMES12.slice(0, 10)) expect(gridNames).toContain(n);

  // CSV（画面の席と、氏名・テーブル・席番号が一致する）
  const csvDownload = await clickAndDownload(page, "CSVでダウンロード");
  expect(csvDownload.suggestedFilename()).toBe("忘年会 座席表.csv");
  const { path: csvPath } = await assertDownloadedFile(csvDownload, { minBytes: 20 });
  const csvText = fs.readFileSync(csvPath, "utf8").replace(/^﻿/, "");
  const lines = csvText.trim().split(/\r?\n/);
  expect(lines[0]).toBe("氏名,テーブル,席番号");
  const csvRows = lines.slice(1).map((l) => l.split(","));
  expect(csvRows).toHaveLength(10);
  for (const [name, table, seat] of csvRows) {
    expect(seats.find((s) => s.name === name)).toMatchObject({ table: Number(table), seat: Number(seat) });
  }

  // 通信: 名前が自社API・外部へ送られていない
  const origin = new URL(baseURL!).origin;
  for (const needle of NAMES12.slice(0, 10)) expect(findLeakedRequests(recorder, needle)).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, origin, ["/api/stripe"])).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, origin)).toEqual([]);
});

test("seating-chart: 手で入れ替えた席順が、そのままPDF・CSVに反映される", async ({ page }) => {
  await openTool(page);
  await fillNames(page, ["甲野一郎", "乙川二郎", "丙谷三郎", "丁原四郎"]);
  await setNumber(page, "テーブル数", 2);
  await setNumber(page, "1テーブルの席数", 2);
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(2);
  // テーブル1の席1 と テーブル2の席2 を入れ替える
  const first = (await readSeats(page)).find((s) => s.table === 1 && s.seat === 1)!;
  const second = (await readSeats(page)).find((s) => s.table === 2 && s.seat === 2)!;
  await page.locator('[data-testid="seating-seat"][data-table="1"][data-seat="1"]').click();
  await page.locator('[data-testid="seating-seat"][data-table="2"][data-seat="2"]').click();
  const swapped = await readSeats(page);
  expect(swapped.find((s) => s.table === 1 && s.seat === 1)!.name).toBe(second.name);
  expect(swapped.find((s) => s.table === 2 && s.seat === 2)!.name).toBe(first.name);

  const csvDownload = await clickAndDownload(page, "CSVでダウンロード");
  const { path: csvPath } = await assertDownloadedFile(csvDownload, { minBytes: 20 });
  const csvText = fs.readFileSync(csvPath, "utf8");
  expect(csvText).toContain(`${second.name},1,1`);
  expect(csvText).toContain(`${first.name},2,2`);
});

test("seating-chart: 大勢・席数が多い場合も、PDFが複数ページになり、全員を含む", async ({ page }) => {
  await openTool(page);
  const many = Array.from({ length: 60 }, (_, i) => `参加者${String(i + 1).padStart(2, "0")}`);
  await fillNames(page, many);
  await setNumber(page, "テーブル数", 10);
  await setNumber(page, "1テーブルの席数", 12);
  await page.getByTestId("seating-arrange").click();
  await expect(page.getByTestId("seating-table")).toHaveCount(10);
  const download = await clickAndDownload(page, "PDFでダウンロード");
  const { path: pdfPath } = await assertDownloadedFile(download, { format: "pdf", minBytes: 1000 });
  const pdf = await extractPdfContent(pdfPath);
  expect(pdf.pageCount).toBeGreaterThanOrEqual(2);
  const text = pdf.text.replace(/\s+/g, "");
  for (const n of many) expect(text, `PDFに「${n}」がありません`).toContain(n);
  for (let t = 1; t <= 10; t++) expect(text).toContain(`テーブル${t}`);
});

test("seating-chart: ツール一覧のURLで開け、関連ツールの案内がある", async ({ page }) => {
  await page.goto("/tools/seating-chart");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("座席表作成");
  await expect(page.getByRole("link", { name: /名簿テンプレート作成/ }).first()).toBeVisible();
});
