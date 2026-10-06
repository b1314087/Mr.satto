"use client";

import { useEffect, useMemo, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import {
  BeforeAfterPreview,
  PREVIEW_COMPUTE_ROWS,
  toGridRows,
} from "@/components/tools/implementations/shared/before-after-table";
import { loadCsvRows, useAsyncFileData } from "@/components/tools/implementations/shared/use-file-data";
import { CsvColumnEditProcessor, editCsvColumnRows } from "@/lib/processors/browser/csv-ops";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

interface ColumnState {
  /** 元のCSVでの列インデックス（0始まり）。並び替えてもこの値は変わらない */
  originalIndex: number;
  /** ヘッダー行から取得した見出し（無い場合は「列1」のような仮名） */
  originalLabel: string;
  included: boolean;
  renameValue: string;
}

/**
 * CSV列編集（Phase 8）。
 * 既存のRFC4180準拠パーサー/シリアライザ（src/lib/utils/csv.ts）のみを経由し、
 * カンマ区切り文字列の独自split/joinは行わない。
 * プレビュー表示のための最初のCSV読み込みは、ファイルが選択された1回だけ行う
 * （実行のたびに再パースしない）。
 */
export function CsvColumnEditorTool() {
  const [file, setFile] = useState<File | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [columns, setColumns] = useState<ColumnState[] | null>(null);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; rowCount: number; columnCount: number } | null>(
    null
  );

  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setColumns(null);
      setRowCount(null);
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setColumns(null);
    setRowCount(null);
    setPreviewError(null);
    setResult(null);
    setError(null);
    setStatus("idle");

    loadCsvRows(file)
      .then((dataRows) => {
        if (cancelled) return;
        const columnCount = dataRows[0].length;
        setRowCount(dataRows.length);
        setColumns(
          Array.from({ length: columnCount }, (_, i) => ({
            originalIndex: i,
            originalLabel: hasHeader && dataRows[0][i] ? dataRows[0][i] : `列${i + 1}`,
            included: true,
            renameValue: "",
          }))
        );
      })
      .catch((e) => {
        if (!cancelled) setPreviewError(e instanceof Error ? e.message : "CSVの読み込みに失敗しました");
      });

    return () => {
      cancelled = true;
    };
    // hasHeaderが変わった時も見出し候補を作り直すため依存に含める
  }, [file, hasHeader]);

  // プレビュー: 出力と同じ editCsvColumnRows で、現在の設定(残す列・順序・列名)を適用した表を作る
  const { data: sourceRows } = useAsyncFileData(file, loadCsvRows);
  const preview = useMemo(() => {
    if (!sourceRows || !columns) return null;
    const limited = sourceRows.length > PREVIEW_COMPUTE_ROWS;
    const rows = limited ? sourceRows.slice(0, PREVIEW_COMPUTE_ROWS) : sourceRows;
    const included = columns.filter((c) => c.included);
    const excluded = new Set(columns.filter((c) => !c.included).map((c) => c.originalIndex));
    const renames: Record<number, string> = {};
    for (const c of included) {
      if (c.renameValue.trim() !== "") renames[c.originalIndex] = c.renameValue.trim();
    }
    let after: string[][] | null = null;
    let afterError: string | null = null;
    try {
      after = editCsvColumnRows(rows, included.map((c) => c.originalIndex), renames, hasHeader);
    } catch (e) {
      afterError = e instanceof Error ? e.message : "プレビューを作成できませんでした";
    }
    const renamedCols = new Set(Object.keys(renames).map(Number));
    return {
      limited,
      total: sourceRows.length,
      before: toGridRows(rows.slice(0, 10), (_, c) => (excluded.has(c) ? "removed" : undefined)),
      after: after
        ? toGridRows(after.slice(0, 10), (r, c) =>
            hasHeader && r === 0 && renamedCols.has(included[c]?.originalIndex) ? "changed" : undefined
          )
        : null,
      afterError,
      rowCount: rows.length,
    };
  }, [sourceRows, columns, hasHeader]);

  function toggleColumn(index: number) {
    setColumns((prev) =>
      prev ? prev.map((c, i) => (i === index ? { ...c, included: !c.included } : c)) : prev
    );
  }

  function updateRename(index: number, value: string) {
    setColumns((prev) => (prev ? prev.map((c, i) => (i === index ? { ...c, renameValue: value } : c)) : prev));
  }

  function move(index: number, direction: -1 | 1) {
    setColumns((prev) => {
      if (!prev) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  async function handleRun() {
    if (!file || !columns) return;
    const included = columns.filter((c) => c.included);
    if (included.length === 0) {
      setError("残す列を1つ以上選択してください");
      setStatus("error");
      return;
    }
    setStatus("processing");
    setError(null);
    try {
      const renames: Record<number, string> = {};
      for (const c of included) {
        if (c.renameValue.trim() !== "") renames[c.originalIndex] = c.renameValue.trim();
      }
      const output = await new CsvColumnEditProcessor().process({
        file,
        columnOrder: included.map((c) => c.originalIndex),
        renames,
        hasHeader,
      });
      setResult(output);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  const downloadName = file ? `${stripExtension(file.name)}-edited.csv` : "edited.csv";

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="text/csv,.csv"
        label="CSVファイルをドラッグ&ドロップ"
        hint="またはタップして選択"
        onFilesSelected={(files) => setFile(files[0])}
        onError={setError}
      />

      {file && <FileList files={[file]} onRemove={() => setFile(null)} />}

      {file && (
        <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
          <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
          1行目を見出し（列名）として扱う
        </label>
      )}

      {previewError && <ErrorMessage message={previewError} />}

      {columns && rowCount !== null && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {rowCount}行 ・ {columns.length}列（チェックを外すと削除、↑↓で並び替え、名前欄でリネームできます）
          </p>
          <ul className="flex flex-col gap-1.5">
            {columns.map((col, index) => (
              <li
                key={col.originalIndex}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-800 dark:bg-neutral-900"
              >
                <input
                  type="checkbox"
                  checked={col.included}
                  onChange={() => toggleColumn(index)}
                  aria-label={`${col.originalLabel}を含める`}
                />
                <span className="w-28 shrink-0 truncate text-neutral-500 dark:text-neutral-400">
                  {col.originalLabel}
                </span>
                <input
                  type="text"
                  value={col.renameValue}
                  onChange={(e) => updateRename(index, e.target.value)}
                  placeholder={hasHeader ? "新しい列名（任意）" : "リネームはヘッダーがある場合のみ有効"}
                  disabled={!hasHeader}
                  className="min-w-0 flex-1 rounded-md border border-neutral-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-950"
                />
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`${col.originalLabel}を上へ移動`}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === columns.length - 1}
                    aria-label={`${col.originalLabel}を下へ移動`}
                    className="rounded-md border border-neutral-300 px-2 py-1 text-xs text-neutral-600 disabled:opacity-30 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    ↓
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && (
        <BeforeAfterPreview
          title="列編集のプレビュー"
          before={preview.before}
          after={preview.after}
          afterError={preview.afterError}
          beforeLabel="編集前"
          afterLabel="編集後"
          maxRows={10}
          maxCols={8}
          totalRows={preview.rowCount}
          afterTotalRows={preview.rowCount}
          legend={[
            { mark: "removed", label: "削除される列" },
            ...(hasHeader ? [{ mark: "changed" as const, label: "名前を変更する列" }] : []),
          ]}
          notes={
            preview.limited
              ? [`ファイルが大きいため、先頭${PREVIEW_COMPUTE_ROWS}行で計算したプレビューです(全${preview.total}行)。実際の処理は全行が対象です。`]
              : undefined
          }
        />
      )}

      {columns && (
        <button
          type="button"
          onClick={handleRun}
          disabled={status === "processing" || columns.filter((c) => c.included).length === 0}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          この内容で保存する
        </button>
      )}

      <ProcessingStatus state={status} successLabel="CSVの生成が完了しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.rowCount}行 ・ {result.columnCount}列 ・ {formatBytes(result.blob.size)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, downloadName)} />
        </div>
      )}
    </div>
  );
}
