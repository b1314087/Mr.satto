"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CSV_DECODE_FAILED_MESSAGE,
  CSV_ENCODING_LABELS,
  CSV_ENCODING_OPTIONS,
  getCsvEncodingChoice,
  getCsvEncodingVersion,
  isCsvLikeFile,
  readCsvText,
  setCsvEncodingChoice,
  subscribeCsvEncoding,
  type CsvDecodeResult,
  type CsvEncodingChoice,
} from "@/lib/utils/csv-encoding";

/**
 * CSVの文字コードの表示と、選び直し（CSVを読むツール共通）。
 *
 * - ふだんは「文字コード：Shift_JIS（自動で判定）」の1行だけを小さく出し、操作のじゃまをしない。
 * - 判定が確かでないとき・文字化けしている可能性があるときだけ、目立つ注意と一緒に出して、選び直してもらう。
 * - 選び直すと、そのファイルを読むプレビュー・変換のすべてが、選んだ文字コードで読み直す（onChange は、
 *   読み込み直しを自分で行うツールのために、選び直したファイルを知らせる）。
 * - CSV以外（Excelなど）のファイルには何も出さない。読み込みはブラウザ内だけで、ファイルは送らない。
 */
export function CsvEncodingControl({ files, onChange }: { files: (File | null | undefined)[]; onChange?: (file: File) => void }) {
  const csvFiles = files.filter((f): f is File => !!f && isCsvLikeFile(f));
  if (csvFiles.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="csv-encoding-list">
      {csvFiles.map((file, i) => (
        <CsvEncodingRow key={`${file.name}-${file.size}-${file.lastModified}-${i}`} file={file} showName={csvFiles.length > 1} onChange={onChange} />
      ))}
    </div>
  );
}

function CsvEncodingRow({ file, showName, onChange }: { file: File; showName: boolean; onChange?: (file: File) => void }) {
  const version = useSyncExternalStore(subscribeCsvEncoding, getCsvEncodingVersion, () => 0);
  const choice = getCsvEncodingChoice(file);
  const [state, setState] = useState<{ file: File; version: number; result: CsvDecodeResult | null; error: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    readCsvText(file, choice).then(
      (result) => alive && setState({ file, version, result, error: false }),
      () => alive && setState({ file, version, result: null, error: true })
    );
    return () => {
      alive = false;
    };
  }, [file, choice, version]);

  const current = state && state.file === file && state.version === version ? state : null;
  const result = current?.result ?? null;
  const warn = !!current && (current.error || !!result?.uncertain || !!result?.hasUnreadable);

  function change(next: CsvEncodingChoice) {
    setCsvEncodingChoice(file, next);
    onChange?.(file);
  }

  const select = (
    <label className="flex items-center gap-1.5">
      <span className="sr-only">{showName ? `${file.name}の` : ""}文字コード</span>
      <select
        value={choice}
        onChange={(e) => change(e.target.value as CsvEncodingChoice)}
        className="rounded-md border border-neutral-300 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
        data-testid="csv-encoding-select"
      >
        {CSV_ENCODING_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );

  const usedLabel = result ? CSV_ENCODING_LABELS[result.encoding] : current?.error ? "読み込めませんでした" : "判定しています…";
  const how = choice === "auto" ? "（自動で判定）" : "（選んだ文字コード）";

  return (
    <div
      className={
        warn
          ? "flex flex-col gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          : "flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400"
      }
      data-testid="csv-encoding"
      data-file-name={file.name}
      data-encoding={result?.encoding ?? ""}
      data-choice={choice}
      data-warning={warn ? "true" : undefined}
      role={warn ? "alert" : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          {showName && <span className="font-medium">{file.name}：</span>}
          文字コード：<span className="font-medium" data-testid="csv-encoding-used">{usedLabel}</span>
          {result && how}
        </span>
        {select}
      </div>
      {warn && (
        <p data-testid="csv-encoding-warning">
          {current?.error
            ? CSV_DECODE_FAILED_MESSAGE
            : result?.hasUnreadable
              ? "読めない文字があり、文字化けしている可能性があります。プレビューの日本語が正しく表示されているか確かめ、正しくなければ文字コードを選び直してください。"
              : "文字コードを自動ではっきり判定できませんでした。プレビューの日本語が正しく表示されているか確かめ、文字化けしていれば文字コードを選び直してください。"}
          （元のファイルは変更しません）
        </p>
      )}
    </div>
  );
}
