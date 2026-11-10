"use client";

import { useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { ResultPopup } from "@/components/common/result-popup";
import {
  BeforeAfterPreview,
  PREVIEW_COMPUTE_ROWS,
  SheetTabs,
  limitSheetRows,
  toGridRows,
  xlsxRowsToText,
} from "@/components/tools/implementations/shared/before-after-table";
import { useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { columnIndexToLetter, readXlsxSheets } from "@/lib/excel/xlsx-simple-io";
import {
  ExcelBlankRemoveProcessor,
  removeBlanksFromSheetRows,
  type BlankRemoveMode,
} from "@/lib/processors/browser/excel-blank-remove";
import { downloadBlob, stripExtension } from "@/lib/utils/format";
import {
  directionLabel,
  loadXlsxForShift,
  planShift,
  rangeLabel,
  shiftedPosition,
  shiftXlsxCells,
  validateShiftRange,
  type ShiftDirection,
  type XlsxShiftOutput,
} from "@/lib/excel/xlsx-shift-cells";

const ACCEPT = ".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** 新工程1：範囲の中で空白のセルを詰める（左に詰める・上に詰める）を追加 */
type ToolMode = BlankRemoveMode | "shift-left" | "shift-up";

const MODE_OPTIONS: { value: ToolMode; label: string }[] = [
  { value: "rows", label: "空白行のみ" },
  { value: "columns", label: "空白列のみ" },
  { value: "both", label: "両方" },
];

const SHIFT_OPTIONS: { value: ToolMode; label: string; direction: ShiftDirection }[] = [
  { value: "shift-left", label: "左に詰める", direction: "left" },
  { value: "shift-up", label: "上に詰める", direction: "up" },
];

/** プレビューに出す行・列の数 */
const SHIFT_PREVIEW_ROWS = 10;
const SHIFT_PREVIEW_COLS = 8;

export function ExcelBlankRemoveTool() {
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<ToolMode>("both");
  const shiftDirection: ShiftDirection | null = mode === "shift-left" ? "left" : mode === "shift-up" ? "up" : null;
  const isShift = shiftDirection !== null;
  const [shiftResult, setShiftResult] = useState<XlsxShiftOutput | null>(null);
  const [useRange, setUseRange] = useState(false);
  const [rangeStartRow, setRangeStartRow] = useState(1);
  const [rangeEndRow, setRangeEndRow] = useState(100);
  const [rangeStartCol, setRangeStartCol] = useState(1);
  const [rangeEndCol, setRangeEndCol] = useState(20);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; removedRows: number; removedColumns: number } | null>(null);

  const [tab, setTab] = useState(0);
  const { data: sheets, error: previewError, loading } = useAsyncFileData(isShift ? null : file, readXlsxSheets);
  const { data: shiftSheets, error: shiftLoadError, loading: shiftLoading } = useAsyncFileData(isShift ? file : null, loadXlsxForShift);
  const shiftRange = { r1: rangeStartRow, r2: rangeEndRow, c1: rangeStartCol, c2: rangeEndCol };

  // 左に詰める・上に詰める：出力と同じ planShift で、選んだシートの範囲の中を詰めたプレビュー
  const shiftPreview = useMemo(() => {
    if (!shiftDirection || !shiftSheets || shiftSheets.length === 0) return null;
    const index = Math.min(tab, shiftSheets.length - 1);
    const sheet = shiftSheets[index];
    const names = shiftSheets.map((x) => x.name);
    const range = { r1: rangeStartRow, r2: rangeEndRow, c1: rangeStartCol, c2: rangeEndCol };
    const rangeError = validateShiftRange(range);
    if (rangeError) return { error: rangeError, names, index, sheet, plan: null, before: null, after: null, rowLabels: [] as number[], colLabels: [] as string[] };
    const ref = (r: number, c: number) => `${columnIndexToLetter(c - 1)}${r}`;
    const plan = planShift((r, c) => sheet.texts.has(ref(r, c)), sheet.merges, range, shiftDirection);
    const after = new Map<string, string>();
    const movedTo = new Set<string>();
    for (const [cellRef, text] of sheet.texts) {
      const m = /^([A-Z]+)(\d+)$/.exec(cellRef);
      if (!m) continue;
      let col = 0;
      for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
      const row = Number(m[2]);
      const to = shiftedPosition(plan, row, col);
      after.set(ref(to.row, to.col), text);
      if (to.row !== row || to.col !== col) movedTo.add(ref(to.row, to.col));
    }
    const rows = Array.from({ length: Math.min(SHIFT_PREVIEW_ROWS, range.r2 - range.r1 + 1) }, (_, i) => range.r1 + i);
    const cols = Array.from({ length: Math.min(SHIFT_PREVIEW_COLS, range.c2 - range.c1 + 1) }, (_, i) => range.c1 + i);
    const skipped = new Set(plan.skippedLines);
    const isSkipped = (r: number, c: number) => (shiftDirection === "left" ? skipped.has(r) : skipped.has(c));
    const header = [{ text: "", mark: undefined }, ...cols.map((c) => ({ text: columnIndexToLetter(c - 1), mark: undefined }))];
    const before = [
      header,
      ...rows.map((r) => [
        { text: String(r), mark: undefined },
        ...cols.map((c) => {
          const k = ref(r, c);
          const moved = plan.moves.has(`${r},${c}`) && sheet.texts.has(k);
          return { text: sheet.texts.get(k) ?? "", mark: moved ? ("changed" as const) : isSkipped(r, c) ? ("removed" as const) : undefined };
        }),
      ]),
    ];
    const afterRows = [
      header,
      ...rows.map((r) => [
        { text: String(r), mark: undefined },
        ...cols.map((c) => {
          const k = ref(r, c);
          return { text: after.get(k) ?? "", mark: movedTo.has(k) ? ("target" as const) : undefined };
        }),
      ]),
    ];
    return { error: null as string | null, names, index, sheet, plan, before, after: afterRows, rowLabels: rows, colLabels: cols.map((c) => columnIndexToLetter(c - 1)) };
  }, [shiftDirection, shiftSheets, tab, rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol]);

  // プレビュー: 出力と同じ removeBlanksFromSheetRows で、選んだシートの空白行・空白列を取り除く
  const preview = useMemo(() => {
    if (isShift || !sheets || sheets.length === 0) return null;
    const { sheets: limitedSheets, limited } = limitSheetRows(sheets);
    const index = Math.min(tab, limitedSheets.length - 1);
    const names = sheets.map((s) => s.name);
    try {
      const result = removeBlanksFromSheetRows(limitedSheets[index].rows, {
        mode: mode as BlankRemoveMode,
        ...(useRange ? { rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol } : {}),
      });
      const source = xlsxRowsToText(result.source);
      const removedRowList = Array.from(result.removedRowIndexes).map((r) => r + 1);
      const removedColList = Array.from(result.removedColumnIndexes).map((c) => columnIndexToLetter(c));
      // 削除される行がある場合は、その周辺が見えるよう、削除行を含む行を優先して表示する
      const shownIdx: number[] = [];
      const wanted = new Set<number>();
      for (const r of result.removedRowIndexes) {
        if (wanted.size >= 4) break;
        wanted.add(r);
        if (r > 0) wanted.add(r - 1);
      }
      for (let r = 0; r < source.length && shownIdx.length < 10; r++) {
        if (r < 4 || wanted.has(r)) shownIdx.push(r);
      }
      const afterText = xlsxRowsToText(result.rows);
      return {
        error: null as string | null,
        names,
        index,
        limited,
        totalRows: sheets[index].rows.length,
        removedRowList,
        removedColList,
        shownRowNumbers: shownIdx.map((r) => r + 1),
        before: shownIdx.map(
          (r) =>
            toGridRows([source[r]], (_, c) =>
              result.removedRowIndexes.has(r) || result.removedColumnIndexes.has(c) ? "removed" : undefined
            )[0]
        ),
        after: toGridRows(afterText.slice(0, 10)),
        afterSize: [afterText.length, afterText[0]?.length ?? 0],
        beforeSize: [source.length, source[0]?.length ?? 0],
      };
    } catch (e) {
      return {
        error: e instanceof Error ? e.message : "プレビューを作成できませんでした",
        names,
        index,
        limited,
        totalRows: 0,
        removedRowList: [] as number[],
        removedColList: [] as string[],
        shownRowNumbers: [] as number[],
        before: null,
        after: null,
        afterSize: [0, 0],
        beforeSize: [0, 0],
      };
    }
  }, [isShift, sheets, tab, mode, useRange, rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol]);

  function handleSelect(files: File[]) {
    setFile(files[0]);
    setResult(null);
    setShiftResult(null);
    setStatus("idle");
    setError(null);
  }

  async function handleRun() {
    if (!file) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    setShiftResult(null);
    if (shiftDirection) {
      try {
        const output = await shiftXlsxCells({ file, sheetIndex: shiftPreview?.index ?? 0, range: shiftRange, direction: shiftDirection });
        setShiftResult(output);
        setStatus("success");
      } catch (e) {
        setError(e instanceof Error ? e.message : "処理に失敗しました");
        setStatus("error");
      }
      return;
    }
    try {
      const output = await new ExcelBlankRemoveProcessor().process({
        file,
        mode: mode as BlankRemoveMode,
        ...(useRange
          ? { rangeStartRow, rangeEndRow, rangeStartCol, rangeEndCol }
          : {}),
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!file || !result) return;
    downloadBlob(result.blob, `${stripExtension(file.name)}-cleaned.xlsx`);
  }

  function handleShiftDownload() {
    if (!file || !shiftResult) return;
    downloadBlob(shiftResult.blob, `${stripExtension(file.name)}-shifted.xlsx`);
  }

  function chooseMode(next: ToolMode) {
    setMode(next);
    setResult(null);
    setShiftResult(null);
    setStatus("idle");
    setError(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept={ACCEPT}
        maxSizeMB={50}
        label="Excelファイル（.xlsx）をドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={handleSelect}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">空白の行・列を削除する</p>
          <div className="flex flex-wrap gap-2" data-testid="blank-remove-modes">
            {MODE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={mode === opt.value}
                onClick={() => chooseMode(opt.value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === opt.value
                    ? "bg-blue-600 text-white"
                    : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">範囲の中で空白のセルを詰める（範囲の外は変わりません）</p>
          <div className="flex flex-wrap gap-2" data-testid="blank-shift-modes">
            {SHIFT_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={mode === opt.value}
                onClick={() => chooseMode(opt.value)}
                data-testid={`blank-${opt.value}`}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  mode === opt.value ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
          {isShift && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400" data-testid="blank-shift-help">
              {shiftDirection === "left"
                ? "範囲の中の各行で、値のあるセルを左へ寄せます（並びは変わりません）。空白のセルは、その行の範囲の右端へ移ります。"
                : "範囲の中の各列で、値のあるセルを上へ寄せます（並びは変わりません）。空白のセルは、その列の範囲の下端へ移ります。"}
              値・数式・書式はセルと一緒に移します。結合したセルがかかる{shiftDirection === "left" ? "行" : "列"}は詰めません。
            </p>
          )}

          {!isShift && (
            <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              <input type="checkbox" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} />
              範囲を指定する（未指定の場合はシート全体が対象）
            </label>
          )}
          {isShift && <p className="text-sm text-neutral-600 dark:text-neutral-300">詰める範囲を指定してください</p>}

          {(useRange || isShift) && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                開始行
                <input
                  type="number"
                  min={1}
                  value={rangeStartRow}
                  onChange={(e) => setRangeStartRow(Number(e.target.value))}
                  data-testid="blank-range-start-row"
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                終了行
                <input
                  type="number"
                  min={1}
                  value={rangeEndRow}
                  onChange={(e) => setRangeEndRow(Number(e.target.value))}
                  data-testid="blank-range-end-row"
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                開始列
                <input
                  type="number"
                  min={1}
                  value={rangeStartCol}
                  onChange={(e) => setRangeStartCol(Number(e.target.value))}
                  data-testid="blank-range-start-col"
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                終了列
                <input
                  type="number"
                  min={1}
                  value={rangeEndCol}
                  onChange={(e) => setRangeEndCol(Number(e.target.value))}
                  data-testid="blank-range-end-col"
                  className="rounded-lg border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                />
              </label>
            </div>
          )}
        </div>
      )}

      {file && isShift && (shiftPreview || shiftLoadError || shiftLoading) && (
        <BeforeAfterPreview
          title={`${shiftDirection ? directionLabel(shiftDirection) : ""}のプレビュー`}
          loading={shiftLoading}
          before={shiftPreview?.before ?? null}
          after={shiftPreview?.after ?? null}
          afterError={shiftLoadError ?? shiftPreview?.error ?? null}
          beforeLabel="詰める前（範囲の中）"
          afterLabel="詰めた後（範囲の中）"
          maxRows={SHIFT_PREVIEW_ROWS + 1}
          maxCols={SHIFT_PREVIEW_COLS + 1}
          headerRow
          header={shiftPreview && <SheetTabs names={shiftPreview.names} active={shiftPreview.index} onChange={setTab} />}
          summary={
            shiftPreview?.plan && (
              <span data-testid="blank-shift-summary">
                動くセル：{shiftPreview.plan.movedCells}個
                {shiftPreview.plan.skippedLines.length > 0 &&
                  ` ／ 結合セルがかかるため詰めない${shiftDirection === "left" ? "行" : "列"}：${shiftPreview.plan.skippedLines.length}`}
              </span>
            )
          }
          legend={[
            { mark: "changed", label: "動くセル" },
            { mark: "target", label: "動いた先" },
            { mark: "removed", label: "結合セルがかかるため詰めない" },
          ]}
          notes={["範囲の左上から、最大10行・8列を表示しています。範囲の外のセルは変わりません。"]}
        />
      )}

      {file && isShift && shiftPreview?.plan && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-100" data-testid="blank-shift-confirm">
          シート「{shiftPreview.sheet.name}」の <strong>{rangeLabel(shiftRange)}</strong> を、<strong>{directionLabel(shiftDirection!)}</strong>（範囲の外のセルは変わりません）
        </div>
      )}

      {file && !isShift && (preview || previewError || loading) && (
        <BeforeAfterPreview
          title="空白削除のプレビュー"
          loading={loading}
          before={preview?.before ?? null}
          after={preview?.after ?? null}
          afterError={previewError ?? preview?.error ?? null}
          beforeLabel="削除前"
          afterLabel="削除後"
          maxRows={10}
          maxCols={8}
          headerRow={false}
          afterTotalRows={preview?.afterSize[0]}
          beforeRowLabels={preview?.shownRowNumbers}
          header={preview && <SheetTabs names={preview.names} active={preview.index} onChange={setTab} />}
          summary={
            preview &&
            !preview.error && (
              <span>
                {preview.beforeSize[0]}行 × {preview.beforeSize[1]}列 → {preview.afterSize[0]}行 × {preview.afterSize[1]}列
                {preview.removedRowList.length > 0 &&
                  ` ／ 除去される行: ${preview.removedRowList.slice(0, 8).join("、")}${preview.removedRowList.length > 8 ? "…" : ""}行目`}
                {preview.removedColList.length > 0 &&
                  ` ／ 除去される列: ${preview.removedColList.slice(0, 8).join("、")}${preview.removedColList.length > 8 ? "…" : ""}列`}
                （すべてのシートに同じ設定を適用）
              </span>
            )
          }
          legend={[{ mark: "removed", label: "削除される空白の行・列" }]}
          notes={[
            "削除される行がある場合は、その周辺の行を優先して表示しています(左端の数字は元の行番号)。",
            ...(preview?.limited
              ? [`ファイルが大きいため、各シートの先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(表示中のシートは全${preview.totalRows}行)。実際の処理は全行が対象です。`]
              : []),
          ]}
        />
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing"} aria-busy={status === "processing" || undefined}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          data-testid="blank-remove-run"
        >
          {shiftDirection ? `${directionLabel(shiftDirection)}` : "空白を削除する"}
        </button>
      )}

      <ProcessingStatus state={status} successLabel={isShift ? "詰めました" : "削除が完了しました"} />
      {error && <ErrorMessage message={error} />}

      {shiftResult && (
        <ResultPopup>
          <div className="flex flex-col gap-1 text-xs text-neutral-600 dark:text-neutral-300" data-testid="blank-shift-result">
            <p>
              シート「{shiftResult.sheetName}」：動かしたセル {shiftResult.movedCells}個
            </p>
            {(shiftResult.formulasKept > 0 || shiftResult.formulasConverted > 0) && (
              <p>
                数式：数式のまま残した {shiftResult.formulasKept}個
                {shiftResult.formulasConverted > 0 && ` ／ 参照を安全に直せないため計算結果の値に置き換えた ${shiftResult.formulasConverted}個`}
              </p>
            )}
            {(shiftResult.otherAdjusted > 0 || shiftResult.otherConverted > 0) && (
              <p>
                ほかのシートの数式：参照を直した {shiftResult.otherAdjusted}個
                {shiftResult.otherConverted > 0 && ` ／ 値に置き換えた ${shiftResult.otherConverted}個`}
              </p>
            )}
            {shiftResult.notices.map((n) => (
              <p key={n} className="text-amber-700 dark:text-amber-300">
                {n}
              </p>
            ))}
          </div>
          <RewardedDownloadGate onDownload={handleShiftDownload} label="Excelファイルをダウンロード" />
        </ResultPopup>
      )}

      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            削除した行: {result.removedRows} ・ 削除した列: {result.removedColumns}
          </p>
          <RewardedDownloadGate onDownload={handleDownload} label="Excelファイルをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
