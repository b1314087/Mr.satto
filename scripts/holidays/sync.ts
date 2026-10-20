/**
 * 内閣府の公式祝日CSVを取得し、検証したうえで、祝日データを自動更新する（Mr.Satto）。
 * GitHub Actions（.github/workflows/sync-holidays.yml）から、毎週実行される。手元でも実行できる。
 *
 *   npm run holidays:sync                         … 公式CSVを取得して、必要なら更新する
 *   npm run holidays:sync -- --dry-run            … 更新内容を表示するだけで、書き換えない
 *   npm run holidays:sync -- --csv-file <パス>    … 通信せず、手元のCSV（Shift_JIS/UTF-8）で試す
 *   npm run holidays:sync -- --url <URL>          … 取得先を変える（試験用）
 *
 * 終了コード:
 *   0  … 正常（変更なし、または更新した）。結果は status=no-change / updated
 *   10 … 取得に失敗した（通信エラー・HTTPエラー・時間切れ）。何も書き換えていない
 *   11 … 取得したデータが不正・不審で、解析・検証に通らなかった。何も書き換えていない
 * どの場合も、検証に通る前に、既存のデータファイルは一切書き換えない。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LIVE_HOLIDAY_DATA, type HolidayData } from "../../src/lib/calendar/holidays";
import {
  CSV_MAX_BYTES,
  OFFICIAL_CSV_URL,
  OfficialDataError,
  decodeOfficialBytes,
  describePlan,
  formatSnapshotCsv,
  parseOfficialCsv,
  parseSnapshotCsv,
  planSync,
  renderGeneratedModule,
  type SyncPlan,
} from "./lib";

export const EXIT_OK = 0;
export const EXIT_FETCH_FAILED = 10;
export const EXIT_INVALID = 11;

const GENERATED_FILE = "src/lib/calendar/holiday-data.generated.ts";
const SNAPSHOT_CSV = "tests/fixtures/static/cao-syukujitsu-decoded.csv";
const SNAPSHOT_META = "tests/fixtures/static/cao-syukujitsu-snapshot.json";

class FetchError extends Error {}

/** 公式CSVを取得する。通信エラー・5xx は数回やり直す。HTMLなど別のものが返されたときは失敗にする */
async function fetchOfficial(url: string): Promise<{ bytes: Uint8Array; lastModified: string | null }> {
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000), headers: { "user-agent": "Mr.Satto holiday sync (+https://mrmatto.vercel.app)", accept: "text/csv,*/*" } });
      if (res.status >= 500) throw new FetchError(`HTTP ${res.status}`);
      if (res.status !== 200) throw Object.assign(new FetchError(`HTTP ${res.status}`), { final: true });
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("text/html")) throw Object.assign(new FetchError(`CSVではなくHTMLが返されました（content-type: ${type}）`), { final: true });
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length > CSV_MAX_BYTES) throw Object.assign(new FetchError(`ファイルが大きすぎます（${buf.length}バイト）`), { final: true });
      return { bytes: buf, lastModified: res.headers.get("last-modified") };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if ((e as { final?: boolean }).final) break;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * Number(process.env.HOLIDAY_SYNC_RETRY_DELAY_MS ?? 4000)));
    }
  }
  throw new FetchError(lastError || "取得に失敗しました");
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

/** 日本時間の今日（YYYY-MM-DD） */
export function todayJst(now = Date.now()): string {
  return new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

/** 実行結果を、GitHub Actions の出力・要約に書く（Actions の外では何もしない） */
function report(outputs: Record<string, string>, summary: string[]): void {
  const out = process.env.GITHUB_OUTPUT;
  if (out) fs.appendFileSync(out, Object.entries(outputs).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const sum = process.env.GITHUB_STEP_SUMMARY;
  if (sum) fs.appendFileSync(sum, summary.join("\n") + "\n");
  const file = process.env.HOLIDAY_SYNC_REPORT_FILE;
  if (file) fs.writeFileSync(file, summary.join("\n") + "\n");
}

export interface RunOptions {
  /** リポジトリのルート */
  root: string;
  /** 公式CSVのバイト列（通信しないとき）。なければ OFFICIAL_CSV_URL から取得する */
  csvBytes?: Uint8Array;
  url?: string;
  dryRun?: boolean;
  today?: string;
  /** 現在の祝日データ（既定は実データ。テスト用） */
  current?: HolidayData;
}

export interface RunResult {
  exitCode: number;
  status: "no-change" | "updated" | "fetch-failed" | "invalid";
  plan?: SyncPlan;
  messages: string[];
}

/** 更新を実行する。書き込みは、検証にすべて通ったあとに、一時ファイルに書いてから置き換える */
export async function runSync(opts: RunOptions): Promise<RunResult> {
  const root = opts.root;
  const today = opts.today ?? todayJst();
  let bytes = opts.csvBytes;
  let lastModified: string | null = null;
  if (!bytes) {
    try {
      const got = await fetchOfficial(opts.url ?? OFFICIAL_CSV_URL);
      bytes = got.bytes;
      lastModified = got.lastModified;
    } catch (e) {
      return { exitCode: EXIT_FETCH_FAILED, status: "fetch-failed", messages: [`公式CSVを取得できませんでした: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }

  let plan: SyncPlan;
  try {
    const rows = parseOfficialCsv(decodeOfficialBytes(bytes));
    const snapshotText = readIfExists(path.join(root, SNAPSHOT_CSV));
    plan = planSync({ rows, current: opts.current ?? LIVE_HOLIDAY_DATA, currentSnapshot: snapshotText === null ? null : parseSnapshotCsv(snapshotText), today });
  } catch (e) {
    if (e instanceof OfficialDataError) return { exitCode: EXIT_INVALID, status: "invalid", messages: e.problems };
    throw e;
  }

  if (plan.status === "invalid") return { exitCode: EXIT_INVALID, status: "invalid", plan, messages: plan.problems };
  if (plan.status === "no-change") return { exitCode: EXIT_OK, status: "no-change", plan, messages: [`変更はありません（確定済みの最終年: ${plan.confirmedThroughYear}年）`] };

  const messages = describePlan(plan);
  if (opts.dryRun) return { exitCode: EXIT_OK, status: "updated", plan, messages: ["（--dry-run: 書き換えていません）", ...messages] };

  // --- 書き換え（すべて一時ファイルに書いてから置き換える） ---
  const snapshotText = formatSnapshotCsv(plan.snapshotRows);
  const meta = {
    source: opts.url ?? OFFICIAL_CSV_URL,
    retrievedAt: today,
    lastModified,
    sourceBytes: bytes.length,
    sourceSha256: sha256(bytes),
    snapshotSha256: sha256(snapshotText),
    rows: plan.snapshotRows.length,
    firstYear: Number(plan.snapshotRows[0].iso.slice(0, 4)),
    lastYear: plan.data.confirmedThroughYear,
  };
  const files: [string, string][] = [
    [GENERATED_FILE, renderGeneratedModule(plan.data, today)],
    [SNAPSHOT_CSV, snapshotText],
    [SNAPSHOT_META, JSON.stringify(meta, null, 2) + "\n"],
  ];
  const temps: [string, string][] = [];
  try {
    for (const [file, content] of files) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, content);
      temps.push([tmp, target]);
    }
    for (const [tmp, target] of temps) fs.renameSync(tmp, target);
  } finally {
    for (const [tmp] of temps) if (fs.existsSync(tmp)) fs.rmSync(tmp);
  }
  return { exitCode: EXIT_OK, status: "updated", plan, messages };
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvFile = argValue(args, "--csv-file");
  const result = await runSync({
    root: process.cwd(),
    csvBytes: csvFile ? new Uint8Array(fs.readFileSync(csvFile)) : undefined,
    url: argValue(args, "--url"),
    dryRun: args.includes("--dry-run"),
    today: process.env.HOLIDAY_SYNC_TODAY,
  });

  const labels = { "no-change": "変更なし", updated: "更新あり", "fetch-failed": "取得失敗", invalid: "データ不正（更新しない）" } as const;
  const ruleReview = result.plan && result.plan.status === "update" ? result.plan.ruleReview : [];
  const summary = [`## 祝日データの自動更新: ${labels[result.status]}`, "", ...result.messages.map((m) => `- ${m}`)];
  if (ruleReview.length) summary.push("", "### 計算ルールの見直しが必要かもしれません", ...ruleReview.map((m) => `- ${m}`));
  console.log(summary.join("\n"));
  report({ status: result.status, rule_review: ruleReview.length ? "true" : "false" }, summary);
  process.exitCode = result.exitCode;
}

// `node sync.js` で直接実行されたときだけ動く（テストからは runSync を呼ぶ）
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
