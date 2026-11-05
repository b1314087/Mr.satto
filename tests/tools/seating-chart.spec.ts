import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as plainTest, expect as plainExpect, type Page } from "@playwright/test";
import { test, expect } from "../fixtures/premium-test";
import { buildMinimalXlsx } from "../fixtures/xlsx-writer";
import { assertDownloadedFile, clickAndDownload } from "../helpers/tool-runner";
import { extractPdfContent, isValidPdfFile } from "../helpers/pdf-inspect";
import { readXlsxSheet } from "../helpers/xlsx-inspect";
import { NetworkRecorder, findLeakedRequests, findSuspiciousApiUploads, findSuspiciousExternalUploads } from "../helpers/network-guard";
import { autoParams, buildLayout, DEFAULT_PARAMS, rotateLayout, roundRing, SEAT_H, SEAT_W, type Purpose } from "@/lib/seating/layouts";
import { namesFromRows, parseParticipants, readingsFromPaste, splitLine } from "@/lib/seating/participants";
import { axisGroups, canShuffle, evictBlocked, fillAroundLocked, shuffleUnlocked } from "@/lib/seating/arrange";
import { isActiveRule, isNear, seatDistance, shuffleWithRules, violatedRules, type SeatRule } from "@/lib/seating/conditions";

/**
 * 座席表作成（seating-chart）のテスト（2026-11 作り直し）。
 * 1. 名簿の読み取り・用途ごとの席の配置と順番（純粋な関数）
 * 2. 画面：用途の選択 → 名前（Excel・CSVの読み込み）→ 入力順に席へ入る → 入れ替え（2人選ぶ・ドラッグ）→ 書き出し
 * 3. 固定のプレビュー、スマホの幅、名前が外部へ送信されないこと
 */

// ---------------------------------------------------------------------------
// 1. 規則
// ---------------------------------------------------------------------------

plainTest("名簿：1行に1人。「,」やタブのあとは役職。空行を除き、同じ名前には番号を付けて残す", () => {
  plainExpect(splitLine("山田 太郎, 部長")).toEqual({ name: "山田 太郎", role: "部長" });
  plainExpect(splitLine("佐藤花子\t課長")).toEqual({ name: "佐藤花子", role: "課長" });
  plainExpect(splitLine("  鈴木   一郎  ")).toEqual({ name: "鈴木 一郎", role: "" });
  const r = parseParticipants("山田太郎,部長\n\n佐藤花子\n山田太郎,係長\n");
  plainExpect(r.participants.map((p) => [p.name, p.role])).toEqual([
    ["山田太郎", "部長"],
    ["佐藤花子", ""],
    ["山田太郎(2)", "係長"],
  ]);
  plainExpect(r.renamedDuplicates).toEqual(["山田太郎(2)"]);
});

plainTest("表の読み込み：「氏名」「役職」の見出しがあればその列、無ければ1列目・2列目", () => {
  const withHeader = namesFromRows([["No", "氏名", "所属"], [1, "山田", "営業部"], [2, "佐藤", null], [3, "", "総務"]]);
  // 「No」の列は出席番号として読む（行の先頭に番号を付ける）
  plainExpect(withHeader).toMatchObject({ count: 2, hadHeader: true, text: "1\t山田\t営業部\n2\t佐藤" });
  const noHeader = namesFromRows([["田中", "部長"], ["小林", "課長"]]);
  plainExpect(noHeader.text).toBe("田中\t部長\n小林\t課長");
});

plainTest("ふりがな：表の「ふりがな」「よみ」の列を読む。まとめて貼り付けは上から順で、途中の空行は順番を保つ", () => {
  const r = namesFromRows([["氏名", "ふりがな", "役職"], ["山田太郎", "やまだ たろう", "部長"], ["佐藤花子", null, ""], ["鈴木一郎", "すずき いちろう", ""]]);
  plainExpect(r.text).toBe("山田太郎\t部長\n佐藤花子\n鈴木一郎");
  plainExpect(r.readings).toEqual(["やまだ たろう", "", "すずき いちろう"]);
  plainExpect(namesFromRows([["氏名", "よみ"], ["田中", "たなか"]]).readings).toEqual(["たなか"]);
  plainExpect(namesFromRows([["氏名"], ["田中"]]).readings).toBeNull();
  const pasted = readingsFromPaste("やまだ\n\nすずき\nあまり\n\n", ["山田", "佐藤", "鈴木"]);
  plainExpect(pasted.readings).toEqual({ 山田: "やまだ", 佐藤: "", 鈴木: "すずき" });
  plainExpect(pasted.extra).toBe(1);
});

plainTest("鍵とシャッフル：鍵の席は動かず、ほかの席だけが並び替わる。入力順に戻すも鍵の席はそのまま", () => {
  const slots = [0, 1, 2, 3, 4, null];
  const locked = new Set([1, 4]);
  for (let k = 0; k < 30; k++) {
    const next = shuffleUnlocked(slots, locked);
    plainExpect(next[1]).toBe(1);
    plainExpect(next[4]).toBe(4);
    plainExpect([...next].sort()).toEqual([...slots].sort());
    plainExpect(next).not.toEqual(slots);
  }
  plainExpect(fillAroundLocked([3, 4, 0, 1, 2, null], new Set([1]), 5)).toEqual([0, 4, 1, 2, 3, null]);
  plainExpect(canShuffle([0, 1], new Set([0]))).toBe(false);
  plainExpect(canShuffle([0, null], new Set())).toBe(true);
  // 空席にした席の人は、次の空いている席へ移る
  plainExpect(evictBlocked([0, 1, 2, null, null], new Set([1]))).toEqual([0, null, 2, 1, null]);
  plainExpect(evictBlocked([0, 1], new Set([0]))).toEqual([null, 1]);
});

function overlaps(purpose: Purpose, params = DEFAULT_PARAMS): boolean {
  const g = buildLayout(purpose, params);
  for (let i = 0; i < g.seats.length; i++)
    for (let j = i + 1; j < g.seats.length; j++) {
      const a = g.seats[i];
      const b = g.seats[j];
      if (Math.abs(a.x - b.x) < SEAT_W && Math.abs(a.y - b.y) < SEAT_H) return true;
    }
  return false;
}

plainTest("どの用途でも、人数に合わせると全員分の席ができ、席どうしが重ならない", () => {
  for (const purpose of ["meeting", "meeting-u", "group", "classroom", "round", "custom"] as Purpose[]) {
    for (const n of [1, 2, 7, 13, 30, 61]) {
      const p = autoParams(purpose, n, DEFAULT_PARAMS);
      const g = buildLayout(purpose, p);
      plainExpect(g.seats.length, `${purpose} ${n}人`).toBeGreaterThanOrEqual(n);
      plainExpect(overlaps(purpose, p), `${purpose} ${n}人`).toBe(false);
    }
  }
  for (const k of [2, 4, 8, 12, 16]) plainExpect(roundRing(k)).toBeGreaterThan(0);
});

plainTest("席の順番：会議（対面）は議長席→議長席に近い順に左右交互、授業は横に／縦に、グループは詰める／配る", () => {
  const meeting = buildLayout("meeting", { ...DEFAULT_PARAMS, perSide: 3, head: true });
  plainExpect(meeting.seats.map((s) => s.group).slice(0, 5)).toEqual(["議長席", "奥側 1番目", "手前側 1番目", "奥側 2番目", "手前側 2番目"]);
  const byRow = buildLayout("classroom", { ...DEFAULT_PARAMS, rows: 2, cols: 3, byColumn: false });
  plainExpect(byRow.seats.map((s) => s.group).slice(0, 4)).toEqual(["前から1列目・左から1番目", "前から1列目・左から2番目", "前から1列目・左から3番目", "前から2列目・左から1番目"]);
  const byCol = buildLayout("classroom", { ...DEFAULT_PARAMS, rows: 2, cols: 3, byColumn: true });
  plainExpect(byCol.seats.map((s) => s.group).slice(0, 3)).toEqual(["前から1列目・左から1番目", "前から2列目・左から1番目", "前から1列目・左から2番目"]);
  const deal = buildLayout("group", { ...DEFAULT_PARAMS, tables: 3, perTable: 4, deal: true });
  plainExpect(deal.seats.map((s) => s.group).slice(0, 4)).toEqual(["島1", "島2", "島3", "島1"]);
  const fill = buildLayout("group", { ...DEFAULT_PARAMS, tables: 3, perTable: 4, deal: false });
  plainExpect(fill.seats.map((s) => s.group).slice(0, 5)).toEqual(["島1", "島1", "島1", "島1", "島2"]);
  const custom = buildLayout("custom", { ...DEFAULT_PARAMS, rows: 2, cols: 2, holes: ["0-1"] });
  plainExpect(custom.seats.length).toBe(3);
});

// ---------------------------------------------------------------------------
// 2. 画面
// ---------------------------------------------------------------------------

const MARKER = "秘密太郎";
const PEOPLE = [`${MARKER}, 社長`, "佐藤花子, 部長", "鈴木一郎, 課長", "高橋次郎", "田中三郎", "小林四郎"];

async function openTool(page: Page, width = 1280) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/tools/seating-chart");
  await expect(page.getByTestId("seat-purpose-meeting")).toBeVisible({ timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="seat-purpose-meeting"]');
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps$"));
    },
    null,
    { timeout: 60_000 }
  );
}

async function start(page: Page, purpose: Purpose, lines: string[]) {
  await page.getByTestId(`seat-purpose-${purpose}`).click();
  await page.getByTestId("seat-names").fill(lines.join("\n"));
}

async function seatNames(page: Page): Promise<string[]> {
  return page.getByTestId("seat").evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.name ?? ""));
}

function seat(page: Page, index: number) {
  return page.locator(`[data-testid="seat"][data-seat-index="${index}"]`);
}

test("seating-chart: 最初は用途だけを選ばせ、選ぶと名前の欄が出る。入力した順番に席番号1から入る（会議は1番が議長席）", async ({ page }) => {
  await openTool(page);
  await expect(page.getByTestId("seat-names")).toHaveCount(0);
  await expect(page.getByTestId("tool-preview")).toHaveCount(0);
  await start(page, "meeting", PEOPLE);
  await expect(page.getByTestId("seat-count")).toContainText("6人 ／ 7席");
  const names = await seatNames(page);
  plainExpect(names.slice(0, 6)).toEqual([MARKER, "佐藤花子", "鈴木一郎", "高橋次郎", "田中三郎", "小林四郎"]);
  await expect(seat(page, 0)).toHaveAttribute("aria-label", `席1：${MARKER}（社長）`);
  // 説明は入れ替えの方法だけ
  await expect(page.getByTestId("seat-swap-help")).toHaveText("入れ替え：席をドラッグ、または2人を選んで［入れ替え］");
});

test("seating-chart: 用途ごとに、人数に合わせた席ができる。授業の並べ方・グループの入れ方・カスタムの通路を変えられる", async ({ page }) => {
  await openTool(page);
  const twelve = Array.from({ length: 12 }, (_, i) => `参加者${i + 1}`);
  await start(page, "classroom", twelve);
  await expect(page.getByTestId("seat-count")).toContainText("12人 ／ 12席");
  await page.getByTestId("seat-by-column").selectOption("col");
  // 縦に並べると、2人目は1列目の後ろ（前から2列目）
  await expect(seat(page, 1)).toHaveAttribute("data-name", "参加者2");
  const box0 = await seat(page, 0).boundingBox();
  const box1 = await seat(page, 1).boundingBox();
  plainExpect(Math.abs(box0!.x - box1!.x)).toBeLessThan(2);
  plainExpect(box1!.y).toBeGreaterThan(box0!.y);

  await page.getByTestId("seat-purpose-group").click();
  await expect(page.getByTestId("seat-count")).toContainText("12人 ／ 12席");
  await page.getByTestId("seat-deal").selectOption("deal");
  await expect(page.getByTestId("seat-count")).toContainText("12人");

  await page.getByTestId("seat-purpose-round").click();
  await expect(page.getByTestId("seat-count")).toContainText("12人 ／ 16席");

  await page.getByTestId("seat-purpose-custom").click();
  await expect(page.getByTestId("seat-count")).toContainText("12人 ／ 12席");
  await page.getByTestId("seat-custom-cell").first().click();
  // 通路にしても、人数に合わせて行が増え、全員が座れる
  await expect(page.getByTestId("seat-shortage")).toHaveCount(0);
  await expect(page.getByTestId("seat-count")).toContainText("12人 ／ 17席");
});

test("seating-chart: 席が足りないときは、足りない席数と座れない人を出し、「人数に合わせる」で直る", async ({ page }) => {
  await openTool(page);
  await start(page, "round", Array.from({ length: 10 }, (_, i) => `名前${i + 1}`));
  await page.getByTestId("seat-tables").fill("1");
  await expect(page.getByTestId("seat-autofit")).not.toBeChecked();
  await expect(page.getByTestId("seat-shortage")).toContainText("席が2席足りません（名前9、名前10）");
  await page.getByTestId("seat-shortage").getByRole("button", { name: "人数に合わせる" }).click();
  await expect(page.getByTestId("seat-shortage")).toHaveCount(0);
});

test("seating-chart: ExcelとCSVの名簿（名前・役職）を読み込める。古い形式（.xls）は案内する", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seating-"));
  const xlsx = path.join(dir, "roster.xlsx");
  fs.writeFileSync(
    xlsx,
    Buffer.from(
      buildMinimalXlsx([
        { name: "名簿", rows: [[{ value: "氏名" }, { value: "役職" }], [{ value: "Excel花子" }, { value: "部長" }], [{ value: "Excel月子" }, { value: "主任" }]] },
      ])
    )
  );
  const csv = path.join(dir, "roster.csv");
  fs.writeFileSync(csv, "No,名前,所属\n1,CSV一郎,営業\n2,CSV二郎,総務\n", "utf8");
  const xls = path.join(dir, "old.xls");
  fs.writeFileSync(xls, "dummy");
  await openTool(page);
  await page.getByTestId("seat-purpose-meeting").click();
  await page.getByTestId("seat-import-input").setInputFiles(xlsx);
  await expect(page.getByText("2人を読み込みました")).toBeVisible();
  await expect(page.getByTestId("seat-names")).toHaveValue("Excel花子\t部長\nExcel月子\t主任");
  await expect(seat(page, 0)).toHaveAttribute("aria-label", "席1：Excel花子（部長）");
  await page.getByTestId("seat-import-input").setInputFiles(csv);
  await expect(page.getByTestId("seat-names")).toHaveValue("1\tCSV一郎\t営業\n2\tCSV二郎\t総務");
  await expect(page.getByTestId("seat-numbers")).toBeChecked();
  await page.getByTestId("seat-import-input").setInputFiles(xls);
  await expect(page.getByRole("alert").filter({ hasText: ".xls" })).toBeVisible();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seating-chart: 2人を選んで「入れ替え」、またはドラッグで入れ替えられ、空席へも動かせる。「入力順に戻す」で戻る", async ({ page }) => {
  await openTool(page);
  await start(page, "group", ["A1", "A2", "A3", "A4", "A5"]);
  await expect(page.getByTestId("seat-swap")).toBeDisabled();
  await seat(page, 0).click();
  await expect(page.getByTestId("seat-swap")).toHaveText("入れ替え（1/2）");
  await seat(page, 2).click();
  await page.getByTestId("seat-swap").click();
  plainExpect((await seatNames(page)).slice(0, 5)).toEqual(["A3", "A2", "A1", "A4", "A5"]);

  // ドラッグ：席2（A2）を席5（A5）に重ねる
  const from = (await seat(page, 1).boundingBox())!;
  const to = (await seat(page, 4).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  plainExpect((await seatNames(page)).slice(0, 5)).toEqual(["A3", "A5", "A1", "A4", "A2"]);

  // 空席（6番）へ動かす
  await seat(page, 0).click();
  await seat(page, 5).click();
  await page.getByTestId("seat-swap").click();
  plainExpect((await seatNames(page)).slice(0, 6)).toEqual(["", "A5", "A1", "A4", "A2", "A3"]);

  // 名前を足しても、入れ替えた席はそのまま。新しい人は空いた席へ
  await page.getByTestId("seat-names").fill(["A1", "A2", "A3", "A4", "A5", "A6"].join("\n"));
  plainExpect((await seatNames(page)).slice(0, 6)).toEqual(["A6", "A5", "A1", "A4", "A2", "A3"]);

  await page.getByTestId("seat-reset").click();
  plainExpect((await seatNames(page)).slice(0, 6)).toEqual(["A1", "A2", "A3", "A4", "A5", "A6"]);
});

test("seating-chart: PCでは、プレビューが真ん中（左）に大きく、メニューが右に並ぶ。メニューを下まで見てもプレビューは見えたまま。選んだ席の操作はプレビューの上に出る", async ({ page }) => {
  await openTool(page, 1440);
  await start(page, "classroom", Array.from({ length: 30 }, (_, i) => `生徒${i + 1}`));
  const preview = (await page.getByTestId("tool-preview").boundingBox())!;
  const menu = (await page.getByTestId("seat-names").boundingBox())!;
  plainExpect(preview.x + preview.width).toBeLessThanOrEqual(menu.x);
  plainExpect(preview.width).toBeGreaterThan(menu.width * 1.8);
  await page.getByTestId("seat-format-pdf").scrollIntoViewIfNeeded();
  await expect(seat(page, 0)).toBeInViewport();
  await seat(page, 3).click();
  // 選んだ席の操作（鍵・札・空席）は、プレビューのすぐ上に出る
  await expect(page.getByTestId("tool-preview").getByTestId("seat-lock")).toBeVisible();
  await expect(page.getByTestId("seat-tag-bar")).toHaveCount(1);
  // 大きく表示しているときは、操作をプレビューの上に出す
  await page.getByTestId("seat-fullscreen").click();
  await expect(page.getByTestId("tool-preview").getByTestId("seat-tag-bar")).toBeVisible();
  await expect(page.getByTestId("seat-tag-bar")).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("seating-chart: スマホ幅では、プレビューは画面の下に固定され、上の入力欄を見ている間も見える。たためる", async ({ page }) => {
  await openTool(page, 390);
  await start(page, "classroom", Array.from({ length: 30 }, (_, i) => `生徒${i + 1}`));
  await page.getByTestId("seat-purpose-meeting").scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  const panel = page.getByTestId("tool-preview");
  const box = (await panel.boundingBox())!;
  const vh = page.viewportSize()!.height;
  plainExpect(box.y + box.height).toBeLessThanOrEqual(vh + 1);
  plainExpect(box.y + box.height).toBeGreaterThan(vh - 4);
  await expect(seat(page, 0)).toBeInViewport();
  await page.getByTestId("seat-preview-toggle").click();
  await expect(page.getByTestId("seat")).toHaveCount(0);
  await page.getByTestId("seat-preview-toggle").click();
  await expect(seat(page, 0)).toBeVisible();
});

test("seating-chart: 画像（PNG・JPEG）・PDF・Excelで書き出せ、入れ替えた席が反映される。名前は外部に送信されない", async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const recorder = new NetworkRecorder(page);
  await openTool(page);
  await start(page, "meeting", PEOPLE);
  await page.getByTestId("seat-title").fill("役員会議");
  await seat(page, 0).click();
  await seat(page, 1).click();
  await page.getByTestId("seat-swap").click();

  const png = await clickAndDownload(page, "画像（PNG）でダウンロード");
  plainExpect(png.suggestedFilename()).toBe("役員会議.png");
  const pngFile = await assertDownloadedFile(png, { format: "png", minBytes: 2000 });
  const buf = fs.readFileSync(pngFile.path);
  plainExpect(buf.readUInt32BE(16)).toBeGreaterThan(500);

  await page.getByTestId("seat-format-jpeg").click();
  const jpg = await clickAndDownload(page, "画像（JPEG）でダウンロード");
  plainExpect(jpg.suggestedFilename()).toBe("役員会議.jpg");
  await assertDownloadedFile(jpg, { format: "jpg", minBytes: 2000 });

  await page.getByTestId("seat-format-pdf").click();
  const pdf = await clickAndDownload(page, "PDFでダウンロード");
  const pdfFile = await assertDownloadedFile(pdf, { format: "pdf" });
  plainExpect(isValidPdfFile(pdfFile.path)).toBe(true);
  const content = await extractPdfContent(pdfFile.path);
  plainExpect(content.pageCount).toBe(1);
  for (const t of ["役員会議", MARKER, "社長", "佐藤花子", "部長", "小林四郎"]) plainExpect(content.text).toContain(t);

  await page.getByTestId("seat-format-xlsx").click();
  const xl = await clickAndDownload(page, "Excel（一覧）でダウンロード");
  const sheet = await readXlsxSheet((await assertDownloadedFile(xl, { format: "zip" })).path);
  const rows = sheet.rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
  const header = rows.findIndex((r) => r[0] === "席番号");
  plainExpect(rows[header]).toEqual(["席番号", "名前", "役職", "場所", "札"]);
  // 入れ替えたので、席1は佐藤花子、席2が秘密太郎
  plainExpect(rows[header + 1].slice(0, 4)).toEqual(["1", "佐藤花子", "部長", "議長席"]);
  plainExpect(rows[header + 2].slice(0, 4)).toEqual(["2", MARKER, "社長", "奥側 1番目"]);

  expect(findLeakedRequests(recorder, MARKER)).toEqual([]);
  expect(findLeakedRequests(recorder, encodeURIComponent(MARKER))).toEqual([]);
  expect(findSuspiciousApiUploads(recorder, baseURL ?? "")).toEqual([]);
  expect(findSuspiciousExternalUploads(recorder, baseURL ?? "")).toEqual([]);
});

test("seating-chart: 席を選んで「来賓」「司会」などの札を付けられ、札は席に残る（人を入れ替えても動かない）。PDFの用紙（A3）を選べる", async ({ page }) => {
  test.setTimeout(120_000);
  await openTool(page);
  await start(page, "round", ["来賓A", "来賓B", "司会C", "一般D"]);
  await expect(page.getByTestId("seat-tag-bar")).toHaveCount(0);
  await seat(page, 0).click();
  await seat(page, 1).click();
  await page.getByTestId("seat-tag-input").fill("来賓");
  await page.getByTestId("seat-tag-apply").click();
  await seat(page, 2).click();
  await page.getByRole("button", { name: "司会", exact: true }).click();
  await page.getByTestId("seat-tag-apply").click();
  await expect(seat(page, 0).getByTestId("seat-tag")).toHaveText("来賓");
  await expect(seat(page, 1).getByTestId("seat-tag")).toHaveText("来賓");
  await expect(seat(page, 2).getByTestId("seat-tag")).toHaveText("司会");
  await expect(seat(page, 0)).toHaveAttribute("aria-label", "席1［来賓］：来賓A");

  // 人を入れ替えても、札は席に残る
  await seat(page, 2).click();
  await seat(page, 3).click();
  await page.getByTestId("seat-swap").click();
  await expect(seat(page, 2)).toHaveAttribute("aria-label", "席3［司会］：一般D");
  await expect(seat(page, 3).getByTestId("seat-tag")).toHaveCount(0);

  // 札を外す
  await seat(page, 1).click();
  await page.getByTestId("seat-tag-clear").click();
  await expect(seat(page, 1).getByTestId("seat-tag")).toHaveCount(0);

  await page.getByTestId("seat-format-pdf").click();
  await page.getByTestId("seat-paper").selectOption("A3");
  const pdf = await clickAndDownload(page, "PDFでダウンロード");
  const content = await extractPdfContent((await assertDownloadedFile(pdf, { format: "pdf" })).path);
  plainExpect(Math.round(Math.max(content.pages[0].width, content.pages[0].height))).toBe(1191);
  plainExpect(content.text).toContain("来賓");
  plainExpect(content.text).toContain("司会");

  await page.getByTestId("seat-format-xlsx").click();
  const xl = await clickAndDownload(page, "Excel（一覧）でダウンロード");
  const sheet = await readXlsxSheet((await assertDownloadedFile(xl, { format: "zip" })).path);
  const rows = sheet.rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
  const h = rows.findIndex((r) => r[0] === "席番号");
  plainExpect(rows[h]).toEqual(["席番号", "名前", "役職", "場所", "札"]);
  plainExpect(rows[h + 1].slice(0, 2).concat(rows[h + 1][4])).toEqual(["1", "来賓A", "来賓"]);
  plainExpect(rows[h + 3].slice(0, 2).concat(rows[h + 3][4])).toEqual(["3", "一般D", "司会"]);
});

test.describe("スマートフォンの幅", () => {
  test("seating-chart: 用途を選び、名前を入れて、プレビューで入れ替えられ、ページが横にはみ出さない", async ({ page }) => {
    await openTool(page, 390);
    await start(page, "round", Array.from({ length: 16 }, (_, i) => `名前${i + 1}`));
    await expect(seat(page, 0)).toBeVisible();
    await seat(page, 0).click();
    await seat(page, 1).click();
    await page.getByTestId("seat-swap").click();
    plainExpect((await seatNames(page)).slice(0, 2)).toEqual(["名前2", "名前1"]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    plainExpect(overflow).toBeLessThanOrEqual(1);
  });
});

test("seating-chart: ツール一覧のURLで開け、関連ツールの案内がある", async ({ page }) => {
  await page.goto("/tools/seating-chart");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("座席表作成");
  await expect(page.getByRole("link", { name: /名簿テンプレート作成/ }).first()).toBeVisible();
});

test("seating-chart: 席に鍵をかけると、シャッフル・入れ替え・入力順に戻すで動かない", async ({ page }) => {
  await openTool(page);
  await start(page, "classroom", ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
  await seat(page, 2).click();
  await page.getByTestId("seat-lock").click();
  await expect(seat(page, 2)).toHaveAttribute("data-locked", "true");
  await expect(seat(page, 2)).toHaveAttribute("aria-label", "席3：B3・鍵");
  const before = await seatNames(page);
  let changed = false;
  for (let k = 0; k < 3; k++) {
    await page.getByTestId("seat-shuffle").click();
    const now = await seatNames(page);
    plainExpect(now[2]).toBe("B3");
    plainExpect(now.filter(Boolean).sort()).toEqual(before.filter(Boolean).sort());
    if (now.join() !== before.join()) changed = true;
  }
  plainExpect(changed).toBe(true);

  // 鍵の席とは入れ替えできない
  await seat(page, 2).click();
  await seat(page, 0).click();
  await expect(page.getByTestId("seat-swap")).toBeDisabled();
  await seat(page, 0).click();
  await seat(page, 2).click();

  await page.getByTestId("seat-reset").click();
  plainExpect((await seatNames(page)).slice(0, 8)).toEqual(["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
  await page.getByTestId("seat-shuffle").click();
  await seat(page, 2).click();
  await expect(page.getByTestId("seat-lock")).toHaveText("🔓 鍵を外す");
  await page.getByTestId("seat-lock").click();
  await expect(seat(page, 2)).not.toHaveAttribute("data-locked", "true");
});

plainTest("席の条件：離す・近くにする・列を決める・今の列のまま を、シャッフルで必ず守る（鍵の席は動かない）。満たせなければ並びを変えない", () => {
  plainExpect(axisGroups([0, 200, 0.5, 400, 201], 50)).toEqual([0, 1, 0, 2, 1]);
  // 4列×4行（席の番号＝行×4＋列）。人の番号＝席の番号、名前は P0〜P15
  const g = { col: Array.from({ length: 16 }, (_, i) => i % 4), row: Array.from({ length: 16 }, (_, i) => Math.floor(i / 4)) };
  const slots = Array.from({ length: 16 }, (_, i) => i);
  const nameOf = (id: number) => `P${id}`;
  const rules: SeatRule[] = [
    { id: "1", kind: "apart", a: "P0", b: "P1", n: 3 },
    { id: "2", kind: "near", a: "P2", b: "P3" },
    { id: "3", kind: "place", a: "P4", axis: "row", from: 1, to: 1 },
    { id: "4", kind: "stay", a: "P5", axis: "col" },
  ];
  for (let k = 0; k < 100; k++) {
    const res = shuffleWithRules(slots, new Set([15]), rules, nameOf, g);
    plainExpect(res.ok).toBe(true);
    const next = res.slots;
    plainExpect(next[15]).toBe(15);
    plainExpect([...next].sort((x, y) => x! - y!)).toEqual(slots);
    const at = (id: number) => next.indexOf(id);
    plainExpect(seatDistance(g, at(0), at(1))).toBeGreaterThanOrEqual(3);
    plainExpect(isNear(g, at(2), at(3))).toBe(true);
    plainExpect(g.row[at(4)]).toBe(0);
    plainExpect(g.col[at(5)]).toBe(1);
    plainExpect(violatedRules(rules, next, nameOf, g)).toEqual([]);
  }
  // 4列×4行では、5席以上は離せない → 見つからず、並びは変えない
  const impossible = shuffleWithRules(slots, new Set(), [{ id: "x", kind: "apart", a: "P0", b: "P1", n: 5 }], nameOf, g);
  plainExpect(impossible.ok).toBe(false);
  plainExpect(impossible.slots).toEqual(slots);
  // 名簿にいない人・同じ人どうしの条件は使わない
  plainExpect(isActiveRule({ id: "y", kind: "near", a: "P0", b: "P0" }, new Set(["P0"]))).toBe(false);
  plainExpect(isActiveRule({ id: "z", kind: "place", a: "だれか", axis: "col", from: 1, to: 1 }, new Set(["P0"]))).toBe(false);
});

test("seating-chart: 鍵の印は最初はプレビューに出ない（生徒に見せても分からない）。右のメニューの「鍵の印を表示する」で確認できる", async ({ page }) => {
  await openTool(page);
  await start(page, "classroom", ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"]);
  await seat(page, 2).click();
  await page.getByTestId("seat-lock").click();
  await expect(seat(page, 2)).toHaveAttribute("data-locked", "true");
  await expect(page.getByTestId("seat-lock-icon")).toHaveCount(0);
  const bgLocked = await seat(page, 2).evaluate((e) => getComputedStyle(e).backgroundColor);
  const bgOther = await seat(page, 3).evaluate((e) => getComputedStyle(e).backgroundColor);
  plainExpect(bgLocked).toBe(bgOther);
  // 切り替えは右のメニュー（編集する側）にあり、プレビューの欄には出ない
  await expect(page.getByTestId("tool-preview").getByTestId("seat-show-marks")).toHaveCount(0);
  await expect(page.getByTestId("seat-marks-section").getByTestId("seat-show-marks")).toBeVisible();
  await expect(page.getByTestId("seat-locked-count")).toHaveText("鍵をかけた席：1席");
  await page.getByTestId("seat-show-marks").check();
  await expect(seat(page, 2).getByTestId("seat-lock-icon")).toBeVisible();
});

/** 席の条件を1つ足す（欄を開いて、種類と人を選ぶ） */
async function addRule(page: Page, kind: "apart" | "near" | "place" | "stay", a: string, b?: string) {
  if ((await page.getByTestId("seat-conditions-body").count()) === 0) await page.getByTestId("seat-conditions-toggle").click();
  await page.getByTestId("seat-rule-add").click();
  const rule = page.getByTestId("seat-rule").last();
  await rule.getByTestId("seat-rule-kind").selectOption(kind);
  await rule.getByTestId("seat-rule-a").selectOption(a);
  if (b) await rule.getByTestId("seat-rule-b").selectOption(b);
  return rule;
}

async function seatGrid(page: Page) {
  return page.getByTestId("seat").evaluateAll((els) =>
    els.map((el) => ({ name: (el as HTMLElement).dataset.name ?? "", x: parseFloat((el as HTMLElement).style.left), y: parseFloat((el as HTMLElement).style.top) }))
  );
}

test("seating-chart: 席の条件は最初はたたまれていて、件数も出ない。条件はプレビュー・印の表示にも出ない", async ({ page }) => {
  await openTool(page);
  await start(page, "classroom", Array.from({ length: 12 }, (_, i) => `N${i + 1}`));
  await expect(page.getByTestId("seat-conditions-toggle")).toHaveText(/^▶\s*席の条件$/);
  await expect(page.getByTestId("seat-conditions-body")).toHaveCount(0);
  await addRule(page, "apart", "N1", "N2");
  await page.getByTestId("seat-conditions-toggle").click();
  await expect(page.getByTestId("seat-conditions-body")).toHaveCount(0);
  // たたんでいると、満たしていない条件があっても「！」だけ（N1とN2は最初は隣どうし）
  await expect(page.getByTestId("seat-conditions-warn")).toBeVisible();
  await expect(page.getByTestId("seat-conditions-toggle")).not.toContainText("1");
  await page.getByTestId("seat-show-marks").check();
  const previewText = await page.getByTestId("tool-preview").innerText();
  plainExpect(previewText).not.toContain("離す");
  plainExpect(previewText).not.toContain("条件");
});

test("seating-chart: 「2人を離す」「近くにする」「列を決める」「今の列のまま」をシャッフルで守る", async ({ page }) => {
  await openTool(page);
  const names = Array.from({ length: 24 }, (_, i) => `N${i + 1}`);
  await start(page, "classroom", names);
  const apart = await addRule(page, "apart", "N1", "N2");
  await apart.getByTestId("seat-rule-n").fill("3");
  await expect(apart).toHaveAttribute("data-unmet", "true");
  await addRule(page, "near", "N3", "N20");
  const place = await addRule(page, "place", "N24");
  await place.getByTestId("seat-rule-axis").selectOption("row");
  await place.getByTestId("seat-rule-from").fill("1");
  await place.getByTestId("seat-rule-to").fill("1");
  await addRule(page, "stay", "N8");

  const before = await seatGrid(page);
  const n8x = before.find((s) => s.name === "N8")!.x;
  const xs = [...new Set(before.map((s) => s.x))].sort((a, b) => a - b);
  const ys = [...new Set(before.map((s) => s.y))].sort((a, b) => a - b);
  const pos = (grid: typeof before, name: string) => {
    const s = grid.find((g) => g.name === name)!;
    return { c: xs.indexOf(s.x), r: ys.indexOf(s.y), x: s.x };
  };
  for (let k = 0; k < 5; k++) {
    await page.getByTestId(k % 2 ? "seat-shuffle" : "seat-rule-apply").click();
    const g = await seatGrid(page);
    const a = pos(g, "N1");
    const b = pos(g, "N2");
    plainExpect(Math.max(Math.abs(a.c - b.c), Math.abs(a.r - b.r))).toBeGreaterThanOrEqual(3);
    const c = pos(g, "N3");
    const d = pos(g, "N20");
    plainExpect(Math.abs(c.c - d.c) + Math.abs(c.r - d.r)).toBe(1);
    plainExpect(pos(g, "N24").r).toBe(0);
    plainExpect(pos(g, "N8").x).toBe(n8x);
  }
  await expect(page.getByTestId("seat-rule").first()).not.toHaveAttribute("data-unmet", "true");
  await expect(page.getByTestId("seat-rule-error")).toHaveCount(0);
});

test("seating-chart: 満たせない条件のときは、並びを変えずに案内を出す（条件の欄の中だけ）", async ({ page }) => {
  await openTool(page);
  await start(page, "classroom", Array.from({ length: 6 }, (_, i) => `N${i + 1}`));
  await page.getByTestId("seat-autofit").uncheck().catch(() => undefined);
  const rule = await addRule(page, "apart", "N1", "N2");
  await rule.getByTestId("seat-rule-n").fill("20");
  const before = await seatNames(page);
  await page.getByTestId("seat-rule-apply").click();
  await expect(page.getByTestId("seat-rule-error")).toContainText("見つかりませんでした");
  plainExpect(await seatNames(page)).toEqual(before);
  plainExpect(await page.getByTestId("tool-preview").innerText()).not.toContain("見つかりませんでした");
  await page.getByTestId("seat-conditions-toggle").click();
  await expect(page.getByTestId("seat-conditions-warn")).toBeVisible();
});

test("seating-chart: 「大きく表示」で座席表を画面いっぱいに出し、そこでも入れ替え・シャッフルでき、Esc・閉じるで戻る", async ({ page }) => {
  await openTool(page);
  await start(page, "classroom", Array.from({ length: 30 }, (_, i) => `生徒${i + 1}`));
  const smallW = (await seat(page, 0).boundingBox())!.width;
  await page.getByTestId("seat-fullscreen").click();
  const preview = page.getByTestId("tool-preview");
  await expect(preview).toHaveAttribute("data-fullscreen", "true");
  const box = (await preview.boundingBox())!;
  plainExpect(box.width).toBeGreaterThanOrEqual(1240);
  plainExpect(box.height).toBeGreaterThanOrEqual(880);
  plainExpect((await seat(page, 0).boundingBox())!.width).toBeGreaterThan(smallW * 1.3);
  await seat(page, 0).click();
  await seat(page, 1).click();
  await page.getByTestId("seat-swap").click();
  plainExpect((await seatNames(page)).slice(0, 2)).toEqual(["生徒2", "生徒1"]);
  await page.getByTestId("seat-shuffle").click();
  await page.keyboard.press("Escape");
  await expect(preview).not.toHaveAttribute("data-fullscreen", "true");
  await page.getByTestId("seat-fullscreen").click();
  await page.getByTestId("seat-fullscreen-close").click();
  await expect(preview).not.toHaveAttribute("data-fullscreen", "true");
});

plainTest("向きを逆にする：前（教卓）が下・左右も逆になり、2回で元に戻る。席の番号・大きさは変わらない", () => {
  const g = buildLayout("classroom", { ...DEFAULT_PARAMS, cols: 3, rows: 2 });
  const r = rotateLayout(g);
  plainExpect(r.width).toBe(g.width);
  plainExpect(r.height).toBe(g.height);
  plainExpect(r.seats).toHaveLength(g.seats.length);
  // 前（教卓）は上 → 下へ
  plainExpect(g.marks[0].y).toBeLessThan(g.seats[0].y);
  plainExpect(r.marks[0].y).toBeGreaterThan(r.seats[0].y);
  // 席1（前の左）は、後ろの右へ
  plainExpect(r.seats[0].x).toBeGreaterThan(r.seats[1].x);
  plainExpect(r.seats[0].y).toBeGreaterThan(r.seats[g.seats.length - 1].y);
  plainExpect(r.seats[0].group).toBe(g.seats[0].group);
  plainExpect(rotateLayout(r)).toEqual(g);
});

test("seating-chart: 「前を下にする」で座席表の向きが逆になり、PDFにも反映される。もう一度押すと戻る", async ({ page }) => {
  await openTool(page);
  await start(page, "classroom", ["前の左", "B2", "B3", "B4", "B5", "B6", "B7", "B8", "B9", "B10", "B11", "後ろの右"]);
  const top = async (i: number) => (await seat(page, i).boundingBox())!.y;
  plainExpect(await top(0)).toBeLessThan(await top(11));
  await page.getByTestId("seat-flip").click();
  await expect(page.getByTestId("seat-flip")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("seat-flip")).toContainText("前を上にする");
  plainExpect(await top(0)).toBeGreaterThan(await top(11));
  await expect(seat(page, 0)).toHaveAttribute("data-name", "前の左");

  await page.getByTestId("seat-format-pdf").click();
  const pdf = await clickAndDownload(page, "PDFでダウンロード");
  const content = await extractPdfContent((await assertDownloadedFile(pdf, { format: "pdf" })).path);
  const y = (text: string) => content.pages[0].items.find((it) => it.str.includes(text))!.y;
  // PDF の y は下から上へ増える：前を下にすると、教卓は「前の左」より下（y が小さい）
  plainExpect(y("教卓")).toBeLessThan(y("前の左"));
  plainExpect(y("前の左")).toBeLessThan(y("後ろの右"));

  await page.getByTestId("seat-flip").click();
  plainExpect(await top(0)).toBeLessThan(await top(11));
});

test("seating-chart: 名前を貼り付けたあとに、ふりがなを入力・まとめて貼り付けでき、未入力は目立つ。画面・Excelに出る", async ({ page }) => {
  test.setTimeout(90_000);
  await openTool(page);
  await start(page, "meeting", ["山田太郎, 部長", "佐藤花子", "鈴木一郎"]);
  await page.getByTestId("seat-furigana").check();
  await expect(page.getByTestId("seat-reading")).toHaveCount(3);
  await expect(page.getByTestId("seat-reading-missing")).toHaveText("未入力 3人");

  // 1人ずつ入力（Enterで次の人へ）
  const first = page.getByLabel("山田太郎のふりがな");
  await first.fill("やまだ たろう");
  await first.press("Enter");
  await expect(page.getByLabel("佐藤花子のふりがな")).toBeFocused();
  await expect(page.getByTestId("seat-reading-missing")).toHaveText("未入力 2人");
  await expect(page.getByLabel("佐藤花子のふりがな")).toHaveAttribute("data-empty", "true");

  // まとめて貼り付け（2行目の空行は「その人は入れない」= 山田は上書き、佐藤は空、鈴木は入る）
  await page.getByTestId("seat-reading-paste-toggle").click();
  await page.getByTestId("seat-reading-paste").fill("ヤマダ タロウ\n\nすずき いちろう");
  await page.getByTestId("seat-reading-paste-apply").click();
  await expect(page.getByText("3人分のふりがなを入れました")).toBeVisible();
  await expect(page.getByLabel("鈴木一郎のふりがな")).toHaveValue("すずき いちろう");
  await page.getByLabel("佐藤花子のふりがな").fill("さとう はなこ");
  await expect(page.getByTestId("seat-reading-missing")).toHaveText("全員入力済み");
  await expect(seat(page, 0).getByTestId("seat-reading-text")).toHaveText("ヤマダ タロウ");

  // 名簿を書き直しても、同じ名前のふりがなは残る
  await page.getByTestId("seat-names").fill(["山田太郎, 部長", "佐藤花子", "鈴木一郎", "高橋次郎"].join("\n"));
  await expect(page.getByTestId("seat-reading-missing")).toHaveText("未入力 1人");

  await page.getByTestId("seat-format-xlsx").click();
  const xl = await clickAndDownload(page, "Excel（一覧）でダウンロード");
  const sheet = await readXlsxSheet((await assertDownloadedFile(xl, { format: "zip" })).path);
  const rows = sheet.rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
  const header = rows.findIndex((r) => r[0] === "席番号");
  plainExpect(rows[header]).toEqual(["席番号", "名前", "ふりがな", "役職", "場所", "札"]);
  plainExpect(rows[header + 1].slice(0, 4)).toEqual(["1", "山田太郎", "ヤマダ タロウ", "部長"]);

  await page.getByTestId("seat-format-pdf").click();
  const pdf = await clickAndDownload(page, "PDFでダウンロード");
  const content = await extractPdfContent((await assertDownloadedFile(pdf, { format: "pdf" })).path);
  plainExpect(content.text).toContain("さとう はなこ");

  // 外すと、画面から消える
  await page.getByTestId("seat-furigana").uncheck();
  await expect(seat(page, 0).getByTestId("seat-reading-text")).toHaveCount(0);
});

test("seating-chart: Excelの「ふりがな」の列も読み込み、ふりがなが自動でオンになる", async ({ page }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seating-kana-"));
  const xlsx = path.join(dir, "kana.xlsx");
  fs.writeFileSync(
    xlsx,
    Buffer.from(
      buildMinimalXlsx([
        { name: "名簿", rows: [[{ value: "氏名" }, { value: "フリガナ" }], [{ value: "山田太郎" }, { value: "ヤマダタロウ" }], [{ value: "佐藤花子" }, { value: "" }]] },
      ])
    )
  );
  await openTool(page);
  await page.getByTestId("seat-purpose-meeting").click();
  await page.getByTestId("seat-import-input").setInputFiles(xlsx);
  await expect(page.getByText("2人を読み込みました（ふりがなも1人分を読み込みました）")).toBeVisible();
  await expect(page.getByTestId("seat-furigana")).toBeChecked();
  await expect(page.getByLabel("山田太郎のふりがな")).toHaveValue("ヤマダタロウ");
  await expect(page.getByTestId("seat-reading-missing")).toHaveText("未入力 1人");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("seating-chart: 席を選んで「空席にする」と、だれも座らない席になり、人は次の席へずれる。シャッフルでも人が入らない", async ({ page }) => {
  test.setTimeout(90_000);
  await openTool(page);
  await start(page, "classroom", ["C1", "C2", "C3", "C4", "C5", "C6"]);
  await expect(page.getByTestId("seat-count")).toContainText("6人 ／ 6席");
  await seat(page, 1).click();
  await page.getByTestId("seat-block").click();
  await expect(seat(page, 1)).toHaveAttribute("data-blocked", "true");
  await expect(seat(page, 1).getByTestId("seat-blocked-label")).toHaveText("空席");
  // 人数に合わせて席が1つ増え、全員が座れる
  await expect(page.getByTestId("seat-count")).toContainText("（うち空席にした席 1）");
  await expect(page.getByTestId("seat-shortage")).toHaveCount(0);
  plainExpect((await seatNames(page)).slice(0, 7)).toEqual(["C1", "", "C2", "C3", "C4", "C5", "C6"]);

  for (let k = 0; k < 3; k++) {
    await page.getByTestId("seat-shuffle").click();
    const now = await seatNames(page);
    plainExpect(now[1]).toBe("");
    plainExpect(now.filter(Boolean).sort()).toEqual(["C1", "C2", "C3", "C4", "C5", "C6"]);
  }
  // 空席にした席とは入れ替えできない
  await seat(page, 1).click();
  await seat(page, 0).click();
  await expect(page.getByTestId("seat-swap")).toBeDisabled();
  await seat(page, 0).click();

  await page.getByTestId("seat-format-xlsx").click();
  const xl = await clickAndDownload(page, "Excel（一覧）でダウンロード");
  const sheet = await readXlsxSheet((await assertDownloadedFile(xl, { format: "zip" })).path);
  const rows = sheet.rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
  const header = rows.findIndex((r) => r[0] === "席番号");
  plainExpect(rows[header + 2].slice(0, 2)).toEqual(["2", "（空席）"]);

  // 戻すと、入力順に詰まる
  await expect(page.getByTestId("seat-block")).toHaveText("空席を戻す");
  await page.getByTestId("seat-block").click();
  await page.getByTestId("seat-reset").click();
  plainExpect((await seatNames(page)).slice(0, 6)).toEqual(["C1", "C2", "C3", "C4", "C5", "C6"]);
  await expect(seat(page, 1)).not.toHaveAttribute("data-blocked", "true");
});

/** ページの指定した場所で、ファイルのドラッグ&ドロップ（dragenter → dragover → drop）を起こす */
async function dropFile(page: Page, selector: string, name: string, mime: string, content: string) {
  await page.evaluate(
    ({ selector, name, mime, content }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([content], name, { type: mime }));
      const el = document.querySelector(selector)!;
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 300, clientY: 300 }));
      }
    },
    { selector, name, mime, content }
  );
}

test("seating-chart: Excel・CSVの名簿を、ページのどこに落としても読み込める（大きく表示している画面でも）", async ({ page }) => {
  await openTool(page);
  await page.getByTestId("seat-purpose-classroom").click();
  await dropFile(page, "h1", "meibo.csv", "text/csv", "氏名\n田中\n高橋\n伊藤\n");
  await expect(page.getByTestId("seat-names")).toHaveValue("田中\n高橋\n伊藤");
  plainExpect((await seatNames(page)).slice(0, 3)).toEqual(["田中", "高橋", "伊藤"]);

  await page.getByTestId("seat-fullscreen").click();
  await expect(page.getByTestId("tool-preview")).toHaveAttribute("data-fullscreen", "true");
  await dropFile(page, '[data-testid="tool-preview"]', "meibo2.csv", "text/csv", "氏名\n山本\n中村\n");
  await expect.poll(async () => (await seatNames(page)).slice(0, 2)).toEqual(["山本", "中村"]);
  await expect(page.getByTestId("tool-preview")).toHaveAttribute("data-fullscreen", "true");
});

plainTest("出席番号：行の先頭の数字（全角も・区切りはいろいろ）を出席番号として読み、名前には含めない。表の「出席番号」の列・数字だけの1列目も読む", () => {
  const r = parseParticipants("12 山田太郎\n３、佐藤花子, 部長\n7\t鈴木\n高橋");
  plainExpect(r.participants.map((p) => [p.number ?? "", p.name, p.role])).toEqual([
    ["12", "山田太郎", ""],
    ["3", "佐藤花子", "部長"],
    ["7", "鈴木", ""],
    ["", "高橋", ""],
  ]);
  plainExpect(r.hasNumbers).toBe(true);
  plainExpect(parseParticipants("3年1組 山田").participants[0]).toMatchObject({ name: "3年1組 山田" });
  const withHeader = namesFromRows([["出席番号", "氏名", "役職"], [1, "山田", "係"], [2, "佐藤", null]]);
  plainExpect(withHeader.text).toBe("1\t山田\t係\n2\t佐藤");
  const noHeader = namesFromRows([[1, "山田"], [2, "佐藤"]]);
  plainExpect(noHeader.text).toBe("1\t山田\n2\t佐藤");
  plainExpect(parseParticipants(withHeader.text).participants.map((p) => [p.number, p.name, p.role])).toEqual([["1", "山田", "係"], ["2", "佐藤", ""]]);
});

plainTest("授業・カスタム：席の間隔は縦も横もすべて同じ。1番の席を4すみから選べ、そこから順番が付く", () => {
  const g = buildLayout("classroom", { ...DEFAULT_PARAMS, cols: 6, rows: 3 });
  const xs = [...new Set(g.seats.map((s) => s.x))].sort((a, b) => a - b);
  const ys = [...new Set(g.seats.map((s) => s.y))].sort((a, b) => a - b);
  const gapsX = xs.slice(1).map((x, i) => x - xs[i] - SEAT_W);
  const gapsY = ys.slice(1).map((y, i) => y - ys[i] - SEAT_H);
  plainExpect(new Set(gapsX).size).toBe(1);
  plainExpect(new Set(gapsY).size).toBe(1);
  plainExpect(gapsX[0]).toBe(gapsY[0]);
  const first = (start: "front-left" | "front-right" | "back-left" | "back-right") => {
    const s = buildLayout("classroom", { ...DEFAULT_PARAMS, cols: 6, rows: 3, start }).seats;
    return { x: s[0].x === Math.min(...s.map((v) => v.x)) ? "left" : "right", y: s[0].y === Math.min(...s.map((v) => v.y)) ? "front" : "back", second: s[1] };
  };
  plainExpect(first("front-left")).toMatchObject({ x: "left", y: "front" });
  plainExpect(first("front-right")).toMatchObject({ x: "right", y: "front" });
  plainExpect(first("back-left")).toMatchObject({ x: "left", y: "back" });
  plainExpect(first("back-right")).toMatchObject({ x: "right", y: "back" });
  // 後ろの右から横に：2番は1番の左隣
  const br = buildLayout("classroom", { ...DEFAULT_PARAMS, cols: 6, rows: 3, start: "back-right" }).seats;
  plainExpect(br[1].y).toBe(br[0].y);
  plainExpect(br[1].x).toBeLessThan(br[0].x);
  plainExpect(br[0].group).toBe("前から3列目・左から6番目");
});

test("seating-chart: 出席番号を付けると、名前の前に番号が出て、画像・PDF・Excelにも入る。1番の席を後ろの右にできる", async ({ page }) => {
  test.setTimeout(120_000);
  await openTool(page);
  await start(page, "classroom", ["12 山田", "3 佐藤", "鈴木"]);
  await expect(page.getByTestId("seat-numbers")).toBeChecked();
  await expect(seat(page, 0).getByTestId("seat-number")).toHaveText("12");
  await expect(seat(page, 2).getByTestId("seat-number")).toHaveText("3"); // 番号の無い人は名簿の順
  plainExpect((await seatNames(page)).slice(0, 3)).toEqual(["山田", "佐藤", "鈴木"]);
  await page.getByTestId("seat-numbers").uncheck();
  await expect(page.getByTestId("seat-number")).toHaveCount(0);
  await page.getByTestId("seat-numbers").check();

  // 1番の席を後ろの右に
  await page.getByTestId("seat-start").selectOption("back-right");
  const box = async (i: number) => (await seat(page, i).boundingBox())!;
  const all = await page.getByTestId("seat").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: r.x, y: r.y })));
  const b0 = await box(0);
  plainExpect(b0.x).toBeGreaterThanOrEqual(Math.max(...all.map((r) => r.x)) - 1);
  plainExpect(b0.y).toBeGreaterThanOrEqual(Math.max(...all.map((r) => r.y)) - 1);
  await expect(seat(page, 0)).toHaveAttribute("data-name", "山田");

  await page.getByTestId("seat-format-pdf").click();
  const pdf = await clickAndDownload(page, "PDFでダウンロード");
  const content = await extractPdfContent((await assertDownloadedFile(pdf, { format: "pdf" })).path);
  plainExpect(content.text).toContain("12 山田");
  await page.getByTestId("seat-format-xlsx").click();
  const xl = await clickAndDownload(page, "Excel（一覧）でダウンロード");
  const sheet = await readXlsxSheet((await assertDownloadedFile(xl, { format: "zip" })).path);
  const rows = sheet.rows.map((r) => r.map((c) => (c == null ? "" : String(c))));
  const h = rows.findIndex((r) => r[0] === "席番号");
  plainExpect(rows[h].slice(0, 3)).toEqual(["席番号", "出席番号", "名前"]);
  plainExpect(rows[h + 1].slice(0, 3)).toEqual(["1", "12", "山田"]);
});

test("seating-chart: 3席以上を選ぶと「入れ替え」の代わりに「選んだ席をシャッフル」が出て、選んだ席の中だけで並び替わる（鍵の席は動かない・選択は外れず続けてシャッフルできる）", async ({ page }) => {
  await openTool(page);
  await start(page, "classroom", Array.from({ length: 12 }, (_, i) => `N${i + 1}`));
  // 席3に鍵をかける
  await seat(page, 2).click();
  await page.getByTestId("seat-lock").click();
  const before = await seatNames(page);
  for (const i of [0, 1, 2, 3, 4]) await seat(page, i).click();
  await expect(page.getByTestId("seat-selected-count")).toHaveText("5席を選択中");
  await expect(page.getByTestId("seat-swap")).toHaveCount(0);
  await expect(page.getByTestId("seat-shuffle-selected")).toHaveText("選んだ5席をシャッフル");
  let changed = false;
  for (let k = 0; k < 4; k++) {
    // 選択は外れないので、そのまま続けてシャッフルできる
    await page.getByTestId("seat-shuffle-selected").click();
    const now = await seatNames(page);
    plainExpect(now[2]).toBe("N3"); // 鍵の席はそのまま
    plainExpect(now.slice(5)).toEqual(before.slice(5)); // 選んでいない席はそのまま
    plainExpect(now.slice(0, 5).sort()).toEqual(before.slice(0, 5).sort());
    if (now.join() !== before.join()) changed = true;
    await expect(page.getByTestId("seat-selected-count")).toHaveText("5席を選択中"); // 選択はそのまま
    for (const i of [0, 1, 2, 3, 4]) await expect(seat(page, i)).toHaveAttribute("aria-pressed", "true");
  }
  plainExpect(changed).toBe(true);
  await page.getByTestId("seat-clear-selection").click();
  // 2席なら「入れ替え」、選択を解除できる
  await seat(page, 6).click();
  await seat(page, 7).click();
  await expect(page.getByTestId("seat-swap")).toBeEnabled();
  await expect(page.getByTestId("seat-shuffle-selected")).toHaveCount(0);
  await page.getByTestId("seat-clear-selection").click();
  await expect(page.getByTestId("seat-tag-bar")).toHaveCount(0);
});
