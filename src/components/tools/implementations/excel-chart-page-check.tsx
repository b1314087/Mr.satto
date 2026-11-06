"use client";

import type { ChartPageCheckResult, ChartPageIssue } from "@/lib/excel/chart-page-check";

/**
 * Excel→PDF：変換の前の「グラフのページ境界チェック」の結果。
 * 警告があっても変換は止めない(ボタンはそのまま押せる)。グラフが多いときは、最初の数件だけを出して残りは折りたたむ。
 */

export type ChartPageCheckState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: ChartPageCheckResult }
  | { state: "error" };

const LEVEL_LABEL: Record<ChartPageIssue["level"], string> = { warning: "警告", caution: "注意", info: "情報" };
const LEVEL_CLASS: Record<ChartPageIssue["level"], string> = {
  warning: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  caution: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  info: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};
const VISIBLE_ROWS = 5;

function pagesText(pages: number[]): string {
  if (pages.length === 0) return "—";
  if (pages.length > 4) return `${pages[0]}〜${pages[pages.length - 1]}ページ（${pages.length}ページ）`;
  return `${pages.join("・")}ページ`;
}

function IssueRow({ issue }: { issue: ChartPageIssue }) {
  return (
    <tr className="border-t border-neutral-200 align-top dark:border-neutral-800" data-testid="chart-page-issue">
      <td className="whitespace-nowrap px-2 py-1.5">
        <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${LEVEL_CLASS[issue.level]}`}>{LEVEL_LABEL[issue.level]}</span>
      </td>
      <td className="px-2 py-1.5">{issue.sheet}</td>
      <td className="px-2 py-1.5">
        <div>
          グラフ{issue.chartNo}（{issue.chartKind}）
        </div>
        {issue.title && <div className="text-neutral-500 dark:text-neutral-400">「{issue.title.replace(/\n/g, " ")}」</div>}
        <div className="text-neutral-500 dark:text-neutral-400">
          {issue.cellRange}・{issue.widthCm}×{issue.heightCm}cm
        </div>
      </td>
      <td className="px-2 py-1.5">{issue.problem}</td>
      <td className="whitespace-nowrap px-2 py-1.5">{pagesText(issue.pages)}</td>
    </tr>
  );
}

export function ExcelChartPageCheck({
  check,
  enabled,
  onToggle,
}: {
  check: ChartPageCheckState;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const toggle = (
    <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
      <input type="checkbox" checked={enabled} onChange={(e) => onToggle(e.target.checked)} className="h-3.5 w-3.5 rounded border-neutral-300" />
      変換の前に、グラフがページの境目にかかっていないかをチェックする
    </label>
  );
  if (!enabled) return <div data-testid="chart-page-check">{toggle}</div>;
  if (check.state === "idle") return <div data-testid="chart-page-check">{toggle}</div>;
  if (check.state === "running") {
    return (
      <div className="flex flex-col gap-1.5" data-testid="chart-page-check">
        {toggle}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">グラフのページ境界をチェックしています…（変換はこのまま始められます）</p>
      </div>
    );
  }
  if (check.state === "error") {
    return (
      <div className="flex flex-col gap-1.5" data-testid="chart-page-check">
        {toggle}
        <p className="text-xs text-neutral-500 dark:text-neutral-400">グラフのページ境界をチェックできませんでした。変換はこのまま行えます。</p>
      </div>
    );
  }
  const { result } = check;
  if (result.checkedCharts === 0) return <div data-testid="chart-page-check">{toggle}</div>;
  const problems = result.issues.filter((i) => i.level !== "info");
  const shown = result.issues.slice(0, VISIBLE_ROWS);
  const rest = result.issues.slice(VISIBLE_ROWS);
  return (
    <div className="flex flex-col gap-2" data-testid="chart-page-check">
      {toggle}
      {result.issues.length === 0 ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300" data-testid="chart-page-check-ok">
          グラフのページ境界チェックが完了しました。問題は検出されませんでした。
        </p>
      ) : (
        <div
          className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs ${
            problems.length > 0
              ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
              : "border-neutral-200 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200"
          }`}
          data-testid="chart-page-check-issues"
        >
          <p className="font-medium">
            {problems.length > 0
              ? "ページ境界に重なっているグラフがあります。PDF出力時にグラフや項目名が途中で切れる可能性があります。"
              : "グラフのページ境界チェックが完了しました。次の点をご確認ください。"}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left">
              <thead>
                <tr className="text-neutral-500 dark:text-neutral-400">
                  <th className="px-2 py-1 font-normal">区分</th>
                  <th className="px-2 py-1 font-normal">シート</th>
                  <th className="px-2 py-1 font-normal">グラフ</th>
                  <th className="px-2 py-1 font-normal">問題</th>
                  <th className="px-2 py-1 font-normal">対象ページ</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((issue) => (
                  <IssueRow key={`${issue.sheet}:${issue.chartNo}`} issue={issue} />
                ))}
              </tbody>
            </table>
          </div>
          {rest.length > 0 && (
            <details>
              <summary className="cursor-pointer select-none">ほかの{rest.length}件を表示</summary>
              <div className="mt-1 overflow-x-auto">
                <table className="w-full min-w-[520px] border-collapse text-left">
                  <tbody>
                    {rest.map((issue) => (
                      <IssueRow key={`${issue.sheet}:${issue.chartNo}`} issue={issue} />
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <p className="text-neutral-600 dark:text-neutral-300">
            このまま変換できます。グラフを1ページに収めたい場合は、Excelでグラフの位置・大きさを調整してから、もう一度読み込んでください（ページの境目は、Excelの「改ページ プレビュー」で確認できます）。
          </p>
        </div>
      )}
    </div>
  );
}
