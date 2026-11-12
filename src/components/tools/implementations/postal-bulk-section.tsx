"use client";

import { useMemo, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { CsvEncodingControl } from "@/components/common/csv-encoding-control";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { Segmented } from "@/components/ui/segmented";
import { SettingsSection } from "@/components/ui/settings-section";
import { usePrehydrationValue } from "@/lib/hooks/use-prehydration-value";
import { usePremiumFeature } from "@/lib/plans/use-premium-feature";
import { featureFlags } from "@/lib/config/features";
import { parseTableFile, type ParsedTableFile } from "@/lib/utils/table-file";
import { csvRowsToBlob } from "@/lib/utils/csv";
import { writeXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import {
  BULK_MAX_ROWS,
  BULK_STATUS_LABEL,
  bulkLookup,
  guessColumns,
  linesFromText,
  resultHeaders,
  type BulkDirection,
  type BulkRowResult,
} from "@/lib/postal/postal-bulk";

const ACCEPT = ".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PREVIEW_ROWS = 50;

type Source = "paste" | "file";

const STATUS_CLASS: Record<BulkRowResult["status"], string> = {
  ok: "text-emerald-700 dark:text-emerald-300",
  multiple: "text-amber-700 dark:text-amber-300",
  "not-found": "text-red-700 dark:text-red-300",
  invalid: "text-red-700 dark:text-red-300",
  empty: "text-ms-muted",
};

/**
 * 郵便番号・住所の一括処理（プレミアム機能）。
 * - 貼り付け（1行に1件）か、Excel・CSVの列を選んで、まとめて調べる。
 * - 結果は表で確かめ、Excel・CSVで保存できる（Excel・CSVを読み込んだときは、元の列の右に結果の列を足す）。
 * - 調べる向き（郵便番号→住所／住所→郵便番号）は、ツールの上で選んだ向きに合わせる。
 */
export function PostalBulkSection({ direction }: { direction: BulkDirection }) {
  const premium = usePremiumFeature();
  const [source, setSource] = useState<Source>("paste");
  const [text, setText] = useState("");
  const textRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  usePrehydrationValue(textRef, text, setText);
  const [file, setFile] = useState<File | null>(null);
  const [table, setTable] = useState<ParsedTableFile | null>(null);
  const [columns, setColumns] = useState<number[]>([0]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<BulkRowResult[] | null>(null);
  /** 結果を出したときの入力（読み込んだ表・向き）。保存のときに使う */
  const [resultMeta, setResultMeta] = useState<{ direction: BulkDirection; table: ParsedTableFile | null; fileName: string | null } | null>(null);

  const zipMode = direction === "zip-to-address";
  // 課金の機能が無い（プランが無い）ときは、だれでも使えるため「プレミアム」とは書かない
  const title = featureFlags.billing ? "まとめて調べる（プレミアム）" : "まとめて調べる";
  const inputs = useMemo(() => {
    if (source === "paste") return linesFromText(text);
    if (!table) return [];
    return table.rows.map((row) =>
      columns
        .map((c) => (row[c] ?? "").trim())
        .filter((v) => v !== "")
        .join("")
    );
  }, [source, text, table, columns]);

  function clearResults() {
    setResults(null);
    setResultMeta(null);
    setProgress(null);
  }

  async function handleFile(files: File[]) {
    const f = files[0];
    if (!f) return;
    setFile(f);
    setError(null);
    setTable(null);
    clearResults();
    try {
      const t = await parseTableFile(f);
      setTable(t);
      setColumns(guessColumns(t.headers, direction));
    } catch (e) {
      setError(e instanceof Error ? e.message : "ファイルを読み込めませんでした。");
    }
  }

  async function run() {
    setError(null);
    if (inputs.length === 0) {
      setError(source === "paste" ? "調べる郵便番号・住所を、1行に1件ずつ貼り付けてください。" : "Excel・CSVのファイルを読み込んでください。");
      return;
    }
    if (inputs.length > BULK_MAX_ROWS) {
      setError(`一度に調べられるのは${BULK_MAX_ROWS.toLocaleString("ja-JP")}件までです（今は${inputs.length.toLocaleString("ja-JP")}件）。分けて調べてください。`);
      return;
    }
    setRunning(true);
    try {
      if (!(await premium.confirm())) {
        setError("まとめて調べる機能は、プレミアムプランの機能です。");
        return;
      }
      const r = await bulkLookup(inputs, direction, (done, total) => setProgress({ done, total }));
      setResults(r);
      setResultMeta({ direction, table: source === "file" ? table : null, fileName: source === "file" ? (file?.name ?? null) : null });
    } catch (e) {
      setError(e instanceof Error ? e.message : "調べられませんでした。");
    } finally {
      setRunning(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<BulkRowResult["status"], number> = { ok: 0, multiple: 0, "not-found": 0, invalid: 0, empty: 0 };
    for (const r of results ?? []) c[r.status]++;
    return c;
  }, [results]);

  function outputRows(): string[][] {
    if (!results || !resultMeta) return [];
    const extra = resultHeaders(resultMeta.direction);
    if (resultMeta.table) {
      const t = resultMeta.table;
      const width = Math.max(t.headers.length, ...t.rows.map((r) => r.length));
      const pad = (row: string[]) => [...row, ...Array.from({ length: width - row.length }, () => "")];
      return [
        [...pad(t.headers), ...extra],
        ...t.rows.map((row, i) => [...pad(row), results[i]?.value ?? "", BULK_STATUS_LABEL[results[i]?.status ?? "empty"], results[i]?.note ?? ""]),
      ];
    }
    return [[resultMeta.direction === "zip-to-address" ? "郵便番号（入力）" : "住所（入力）", ...extra], ...results.map((r) => [r.input, r.value, BULK_STATUS_LABEL[r.status], r.note])];
  }

  function baseName(): string {
    const suffix = resultMeta?.direction === "zip-to-address" ? "住所付き" : "郵便番号付き";
    return resultMeta?.fileName ? `${stripExtension(resultMeta.fileName)}-${suffix}` : `郵便番号・住所の検索結果-${suffix}`;
  }

  async function downloadXlsx() {
    // 郵便番号は文字として書き出す（Excelで数値にすると先頭の0が消えるため）
    const blob = await writeXlsxSheets([{ name: "検索結果", rows: outputRows() }]);
    downloadBlob(blob, `${baseName()}.xlsx`);
  }

  function downloadCsv() {
    downloadBlob(csvRowsToBlob(outputRows()), `${baseName()}.csv`);
  }

  if (!premium.allowed) {
    return (
      <SettingsSection title={title} testId="postal-bulk" defaultOpen>
        <p className="text-sm text-ms-text" data-testid="postal-bulk-premium-note">
          郵便番号・住所の一覧を貼り付けたり、Excel・CSVを読み込んだりして、まとめて調べる機能は、プレミアムプランでご利用いただけます。
        </p>
        <p className="text-xs text-ms-muted">1件ずつの検索は、このまま無料でお使いいただけます。</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title={title} testId="postal-bulk" defaultOpen summary={zipMode ? "郵便番号→住所" : "住所→郵便番号"}>
      <p className="text-xs text-ms-muted">
        {zipMode ? "郵便番号の一覧から、住所をまとめて調べます。" : "住所の一覧から、郵便番号をまとめて調べます（住所は都道府県名から入れてください）。"}
        調べる向きは、上の「{zipMode ? "郵便番号から住所" : "住所から郵便番号"}」の選択に合わせています。最大{BULK_MAX_ROWS.toLocaleString("ja-JP")}件まで。
      </p>
      <Segmented
        ariaLabel="まとめて調べる入力の方法"
        testId="postal-bulk-source"
        value={source}
        onChange={(v: Source) => {
          setSource(v);
          setError(null);
          clearResults();
        }}
        options={[
          { value: "paste", label: "貼り付け" },
          { value: "file", label: "Excel・CSVを読み込む" },
        ]}
      />

      {source === "paste" ? (
        <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
          {zipMode ? "郵便番号（1行に1件）" : "住所（1行に1件。都道府県名から）"}
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              clearResults();
            }}
            rows={6}
            ref={textRef}
            data-testid="postal-bulk-text"
            placeholder={zipMode ? "例：\n100-0001\n650-0001\n0600001" : "例：\n東京都千代田区千代田1-1\n兵庫県神戸市中央区加納町6-5-1"}
            className="rounded-lg border border-neutral-300 px-3 py-2 font-mono text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
        </label>
      ) : (
        <div className="flex flex-col gap-3">
          <FileDropzone
            compact={!!file}
            accept={ACCEPT}
            maxSizeMB={20}
            label="Excel・CSVをドラッグ&ドロップ"
            hint="またはタップして選択（.xlsx・.csv。1行目は見出し）"
            onFilesSelected={(files) => void handleFile(files)}
            onError={setError}
            pageDrop={false}
          />
          <CsvEncodingControl files={[file]} onChange={(f) => void handleFile([f])} />
          {table && (
            <div className="flex flex-col gap-2" data-testid="postal-bulk-columns">
              <p className="text-xs text-ms-muted" data-testid="postal-bulk-file-info">
                「{file?.name}」から{table.rows.length.toLocaleString("ja-JP")}行を読み込みました。
              </p>
              <p className="text-xs font-medium text-neutral-600 dark:text-neutral-300">
                {zipMode ? "郵便番号の列" : "住所の列（都道府県・市区町村・番地が別の列のときは、複数選ぶと左からつなげます）"}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {table.headers.map((h, i) => (
                  <label key={`${h}-${i}`} className="flex items-center gap-1.5 text-sm text-neutral-700 dark:text-neutral-200">
                    <input
                      type={zipMode ? "radio" : "checkbox"}
                      name="postal-bulk-column"
                      checked={columns.includes(i)}
                      data-testid={`postal-bulk-col-${i}`}
                      onChange={(e) => {
                        clearResults();
                        if (zipMode) setColumns([i]);
                        else setColumns((prev) => (e.target.checked ? [...prev, i].sort((a, b) => a - b) : prev.filter((c) => c !== i)));
                      }}
                    />
                    {h || `${i + 1}列目`}
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running || inputs.length === 0}
          data-testid="postal-bulk-run"
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          {running ? "調べています…" : `${inputs.length.toLocaleString("ja-JP")}件をまとめて調べる`}
        </button>
        {running && progress && (
          <span className="text-xs text-ms-muted" data-testid="postal-bulk-progress">
            {progress.done.toLocaleString("ja-JP")} / {progress.total.toLocaleString("ja-JP")}件
          </span>
        )}
      </div>

      {error && <ErrorMessage message={error} />}

      {results && resultMeta && (
        <div className="flex flex-col gap-2" data-testid="postal-bulk-results">
          <p className="text-sm font-semibold text-ms-text" data-testid="postal-bulk-summary">
            {results.length.toLocaleString("ja-JP")}件中、見つかった{counts.ok.toLocaleString("ja-JP")}件・候補が複数{counts.multiple.toLocaleString("ja-JP")}件・見つからない{(counts["not-found"] + counts.invalid).toLocaleString("ja-JP")}件
            {counts.empty > 0 && `・空欄${counts.empty.toLocaleString("ja-JP")}件`}
          </p>
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="w-full min-w-[32rem] text-left text-xs">
              <thead className="bg-neutral-50 text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
                <tr>
                  <th className="px-2 py-1.5 font-medium">行</th>
                  <th className="px-2 py-1.5 font-medium">{resultMeta.direction === "zip-to-address" ? "郵便番号" : "住所"}</th>
                  <th className="px-2 py-1.5 font-medium">{resultMeta.direction === "zip-to-address" ? "住所" : "郵便番号"}</th>
                  <th className="px-2 py-1.5 font-medium">状態・備考</th>
                </tr>
              </thead>
              <tbody>
                {results.slice(0, PREVIEW_ROWS).map((r, i) => (
                  <tr key={i} className="border-t border-neutral-200 align-top dark:border-neutral-800" data-testid="postal-bulk-row" data-status={r.status}>
                    <td className="px-2 py-1.5 text-ms-muted tabular-nums">{resultMeta.table ? i + 2 : i + 1}</td>
                    <td className="break-all px-2 py-1.5">{r.input}</td>
                    <td className="break-all px-2 py-1.5 font-medium" data-testid="postal-bulk-value">
                      {r.value}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={STATUS_CLASS[r.status]}>{BULK_STATUS_LABEL[r.status]}</span>
                      {r.note && <span className="block text-ms-muted">{r.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {results.length > PREVIEW_ROWS && <p className="text-xs text-ms-muted">先頭の{PREVIEW_ROWS}件を表示しています。すべての結果は、保存したファイルで確かめられます。</p>}
          <p className="text-xs text-ms-muted">
            {resultMeta.table ? "保存するファイルは、読み込んだ表の右に「検索結果」「検索の状態」「備考」の列を足したものです。" : "保存するファイルには、入力・検索結果・検索の状態・備考が入ります。"}
            「候補が複数」の行は、先頭の候補を入れています。備考の候補を確かめてください。
          </p>
          <div className="flex flex-wrap gap-2">
            <RewardedDownloadGate onDownload={() => void downloadXlsx()} label="Excelで保存" />
            <RewardedDownloadGate onDownload={downloadCsv} label="CSVで保存" />
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
