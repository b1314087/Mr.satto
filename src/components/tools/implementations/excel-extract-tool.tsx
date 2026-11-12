"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import { PreviewGrid, PreviewShell, SheetTabs, type GridCell } from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { loadXlsxForColumnEdit } from "@/lib/excel/xlsx-column-edit";
import { ExcelExtractProcessor, findExtractTargets, type ExcelExtractOutput, type ExtractAxis } from "@/lib/processors/browser/excel-extract";
import { columnToLetters } from "@/lib/compare/office-reader";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import { RunBar } from "@/components/ui/run-bar";
import { StepHeading } from "@/components/ui/step-heading";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PREVIEW_ROWS = 12;
const PREVIEW_COLS = 8;

const AXIS_OPTIONS: { value: ExtractAxis; label: string }[] = [
  { value: "rows", label: "行を抽出" },
  { value: "columns", label: "列を抽出" },
];

/**
 * Excel行・列抽出（次期機能追加 2）。
 * Excelを読み込み、検索する文字を入れると、その文字を含む行（または列）だけを残したExcelを書き出す。
 * 書き出す前に、残る行・列をプレビューで確かめられる（プレビューと書き出しは同じ判定 findExtractTargets を使う）。
 */
export function ExcelExtractTool() {
  const [file, setFile] = useState<File | null>(null);
  const [axis, setAxis] = useState<ExtractAxis>("rows");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [keepHeader, setKeepHeader] = useState(true);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExcelExtractOutput | null>(null);

  const { data: sheets, error: loadError, loading } = useAsyncFileData(file, loadXlsxForColumnEdit);
  const activeSheet = sheets ? Math.min(sheetIndex, sheets.length - 1) : 0;
  const sheet = sheets?.[activeSheet] ?? null;

  const preview = useMemo(() => {
    if (!sheet) return null;
    const match = findExtractTargets({ rows: sheet.rows, query, axis, caseSensitive, keepHeader });
    const colCount = sheet.rows[0]?.length ?? 0;
    const mark = (r: number, c: number) => (match.matchedCells.has(`${r},${c}`) ? ("target" as const) : undefined);
    let grid: GridCell[][];
    let rowLabels: (string | number)[];
    if (axis === "rows") {
      const rowsToShow = query === "" ? sheet.rows.map((_, i) => i) : match.kept;
      grid = rowsToShow.map((r) => sheet.rows[r].map((text, c) => ({ text, mark: mark(r, c) })));
      rowLabels = rowsToShow.map((r) => r + 1);
      // 1行目に元の列の名前（A・B…）を出す
      grid.unshift(Array.from({ length: colCount }, (_, c) => ({ text: `${columnToLetters(c + 1)}列`, align: "center" as const })));
      rowLabels.unshift("");
    } else {
      const colsToShow = query === "" ? Array.from({ length: colCount }, (_, i) => i) : match.kept;
      grid = sheet.rows.map((row, r) => colsToShow.map((c) => ({ text: row[c] ?? "", mark: mark(r, c) })));
      rowLabels = sheet.rows.map((_, r) => r + 1);
      grid.unshift(colsToShow.map((c) => ({ text: `${columnToLetters(c + 1)}列`, align: "center" as const })));
      rowLabels.unshift("");
    }
    return { match, grid, rowLabels, total: axis === "rows" ? sheet.rows.length : colCount };
  }, [sheet, query, axis, caseSensitive, keepHeader]);

  function reset() {
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setSheetIndex(0);
    reset();
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new ExcelExtractProcessor().process({ file, sheetIndex: activeSheet, query, axis, caseSensitive, keepHeader });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "抽出に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-抽出.xlsx`);
  }

  const noun = axis === "rows" ? "行" : "列";
  const canRun = !!sheet && query !== "" && (preview?.match.matchedCount ?? 0) > 0 && status !== "processing";

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <StepHeading n={1} as="h2">
          Excelファイルを選ぶ
        </StepHeading>
        <FileDropzone
          compact={!!file}
          accept={ACCEPT}
          maxSizeMB={50}
          label="Excelファイル（.xlsx）をドラッグ&ドロップ"
          hint="またはタップして選択"
          onFilesSelected={handleSelect}
          onError={setError}
        />
        {file && (
          <FileList
            files={[file]}
            onRemove={() => {
              setFile(null);
              reset();
            }}
          />
        )}
      </section>

      {file && (
        <section className="flex flex-col gap-3" data-testid="excel-extract-settings">
          <StepHeading n={2} as="h2">
            抽出の方法と、検索する文字
          </StepHeading>
          <div className="ms-seg w-fit" role="group" aria-label="抽出の方法" data-testid="excel-extract-axis">
            {AXIS_OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                aria-pressed={axis === o.value}
                data-testid={`excel-extract-axis-${o.value}`}
                onClick={() => {
                  setAxis(o.value);
                  reset();
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-ms-muted">
            {axis === "rows"
              ? "指定した文字を含むセルが1つでもある行を残します。列の並びはそのままです。"
              : "指定した文字を含むセルが1つでもある列を残します。行の並びはそのままです。"}
          </p>
          <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300 sm:max-w-sm">
            検索する文字
            <input
              type="text"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                reset();
              }}
              placeholder="例: 東京"
              data-testid="excel-extract-query"
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            <span className="font-normal text-ms-muted">セルの中に、この文字が含まれていれば一致します（部分一致）。</span>
          </label>
          <div className="flex flex-col gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={keepHeader}
                onChange={(e) => {
                  setKeepHeader(e.target.checked);
                  reset();
                }}
                data-testid="excel-extract-keep-header"
              />
              {axis === "rows" ? "1行目（見出し）も残す" : "A列（見出し）も残す"}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(e) => {
                  setCaseSensitive(e.target.checked);
                  reset();
                }}
                data-testid="excel-extract-case"
              />
              大文字・小文字を区別する
            </label>
          </div>
        </section>
      )}

      {file && (sheet || loading || loadError) && (
        <PreviewShell
          title="抽出結果のプレビュー"
          loading={loading}
          summary={
            sheet &&
            preview &&
            (query === "" ? (
              <span>検索する文字を入れると、残る{noun}だけを表示します。</span>
            ) : preview.match.matchedCount === 0 ? (
              <span data-testid="excel-extract-count">
                「{query}」を含む{noun}はありません（シート「{sheet.name}」）。
              </span>
            ) : (
              <span data-testid="excel-extract-count">
                全{preview.total}
                {noun}のうち、{preview.match.matchedCount}
                {noun}が「{query}」を含みます
                {preview.match.kept.length > preview.match.matchedCount ? `（見出しを含めて${preview.match.kept.length}${noun}を書き出します）` : ""}
              </span>
            ))
          }
          legend={query !== "" && preview && preview.match.matchedCount > 0 ? [{ mark: "target", label: "検索した文字を含むセル（左端の数字は元の行番号、上の行は元の列）" }] : undefined}
          notes={
            sheets && sheets.length > 1
              ? [`抽出するのは、選んでいるシート（${sheet?.name ?? ""}）だけです。ほかのシートは変更せずに、そのまま書き出します。`]
              : undefined
          }
        >
          {loadError && <ErrorMessage message={loadError} />}
          {sheets && <SheetTabs names={sheets.map((s) => s.name)} active={activeSheet} onChange={(i) => { setSheetIndex(i); reset(); }} />}
          {preview && (
            <div className="overflow-x-auto">
              <PreviewGrid rows={preview.grid} rowLabels={preview.rowLabels} maxRows={PREVIEW_ROWS + 1} maxCols={PREVIEW_COLS} headerRow />
            </div>
          )}
        </PreviewShell>
      )}

      {file && (
        <RunBar>
          <button
            type="button"
            onClick={handleRun}
            disabled={!canRun}
            aria-busy={status === "processing" || undefined}
            data-testid="excel-extract-run"
            className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {noun}を抽出する
          </button>
        </RunBar>
      )}

      <ProcessingStatus state={status} successLabel="抽出が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="excel-extract-result">
            シート「{result.sheetName}」から{result.matchedCount}
            {noun}を抽出しました（{result.rowCount}行 × {result.columnCount}列）
          </p>
          {result.formulas && result.formulas.converted > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              位置が変わって参照先を正しく直せない数式{result.formulas.converted}個は、計算結果の値に置き換えました。
            </p>
          )}
          {result.notices.map((n) => (
            <p key={n} className="text-xs text-neutral-500 dark:text-neutral-400">
              {n}
            </p>
          ))}
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
