"use client";

import { useEffect, useState } from "react";
import { CsvPreviewTable } from "@/components/tools/implementations/shared/csv-preview-table";
import { readSpreadsheetForPreview } from "@/lib/preview/sheet";
import type { ExcelSheet } from "@/lib/processors/browser/csv-excel";

/**
 * Excel(.xlsx)・CSVファイルの中身を表で確認するプレビュー。
 * 複数シートはタブで切り替える。ファイルが変わると自動で読み込み直す。
 * 読み込みはブラウザ内で行い、ファイルは送信されない。
 */
export function SheetFilePreview({
  file,
  title = "ファイルの内容(プレビュー)",
  maxRows = 10,
  maxCols = 8,
  sheetIndex,
  onSheetsLoaded,
}: {
  file: File | null;
  title?: string;
  maxRows?: number;
  maxCols?: number;
  /** 指定すると、そのシートだけを表示する(タブは出さない) */
  sheetIndex?: number;
  onSheetsLoaded?: (sheets: ExcelSheet[]) => void;
}) {
  // どのファイルの読み込み結果かを持つ(ファイルが変わったら自動的に「読み込み中」へ戻る)
  const [loaded, setLoaded] = useState<{ file: File; sheets: ExcelSheet[] } | null>(null);
  const [failed, setFailed] = useState<{ file: File; message: string } | null>(null);
  const [tab, setTab] = useState(0);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    readSpreadsheetForPreview(file)
      .then((sheets) => {
        if (cancelled) return;
        setLoaded({ file, sheets });
        onSheetsLoaded?.(sheets);
      })
      .catch((e) => {
        if (!cancelled) setFailed({ file, message: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      });
    return () => {
      cancelled = true;
    };
    // onSheetsLoaded は呼び出し側の再描画で変わるため依存に含めない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  if (!file) return null;
  const sheets = loaded && loaded.file === file ? loaded.sheets : null;
  const error = failed && failed.file === file ? failed.message : null;
  const active = sheetIndex ?? Math.min(tab, (sheets?.length ?? 1) - 1);

  return (
    <section aria-label={title} data-testid="sheet-preview" className="flex flex-col gap-2 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{title}</p>
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!sheets && !error && <p className="text-xs text-neutral-400">読み込み中…</p>}
      {sheets && sheets.length > 1 && sheetIndex === undefined && (
        <div role="tablist" aria-label="シート" className="flex flex-wrap gap-1">
          {sheets.map((s, i) => (
            <button
              key={`${s.name}-${i}`}
              type="button"
              role="tab"
              aria-selected={i === active}
              onClick={() => setTab(i)}
              className={`rounded-md px-2.5 py-1 text-xs ${i === active ? "bg-blue-600 text-white" : "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
      {sheets && (sheets[active]?.rows.length ?? 0) > 0 ? (
        <CsvPreviewTable rows={sheets[active].rows} maxRows={maxRows} maxCols={maxCols} />
      ) : (
        sheets && <p className="text-xs text-neutral-400">表示できるデータがありません</p>
      )}
    </section>
  );
}
