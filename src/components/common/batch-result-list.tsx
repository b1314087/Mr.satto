"use client";

import { useState } from "react";
import type { BatchItemStatus } from "@/lib/batch/run-batch";
import { createZip } from "@/lib/utils/zip";
import { downloadBlob, formatBytes } from "@/lib/utils/format";

export interface BatchResultRow {
  /** 元のファイル名 */
  sourceName: string;
  status: BatchItemStatus;
  /** 書き出すファイル名（同じ名前が重ならないよう、呼び出し側でそろえておく） */
  outputName?: string;
  blob?: Blob;
  /** 補足（例:「元の45%」「目標サイズに届きませんでした」） */
  detail?: string;
  error?: string;
}

const STATUS_LABEL: Record<BatchItemStatus, string> = {
  waiting: "待機中",
  processing: "処理中",
  done: "完了",
  error: "失敗",
};

const STATUS_CLASS: Record<BatchItemStatus, string> = {
  waiting: "bg-ms-hover-tint text-ms-muted",
  processing: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  error: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200",
};

/**
 * 一括処理の結果一覧（共通）。ファイルごとに「待機中・処理中・完了・失敗」を出し、
 * 完了したファイルは1つずつ保存でき、完了したファイルだけをZIPにまとめて保存することもできる。
 * 失敗したファイルは保存の対象に含めない。
 */
export function BatchResultList({ rows, zipName }: { rows: BatchResultRow[]; zipName: string }) {
  const [zipping, setZipping] = useState(false);
  const [zipError, setZipError] = useState<string | null>(null);
  if (rows.length === 0) return null;

  const done = rows.filter((r) => r.status === "done" && r.blob && r.outputName);
  const failed = rows.filter((r) => r.status === "error").length;
  const finished = rows.every((r) => r.status === "done" || r.status === "error");

  async function handleZip() {
    setZipping(true);
    setZipError(null);
    try {
      const zip = await createZip(done.map((r) => ({ name: r.outputName!, blob: r.blob! })));
      downloadBlob(zip, zipName);
    } catch (e) {
      setZipError(e instanceof Error ? e.message : "ZIPファイルを作成できませんでした");
    } finally {
      setZipping(false);
    }
  }

  return (
    <section aria-label="一括処理の結果" data-testid="batch-results" className="flex flex-col gap-3 rounded-xl border border-ms-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-ms-text" aria-live="polite" data-testid="batch-summary">
          {finished
            ? `${rows.length}ファイル中 ${done.length}ファイルが完了${failed > 0 ? `・${failed}ファイルが失敗` : ""}`
            : `処理中（${rows.filter((r) => r.status === "done" || r.status === "error").length} / ${rows.length}）`}
        </p>
        {finished && done.length > 1 && (
          <button
            type="button"
            onClick={handleZip}
            disabled={zipping}
            aria-busy={zipping || undefined}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
          >
            {zipping ? "ZIPを作成中..." : `完了した${done.length}ファイルをZIPで保存`}
          </button>
        )}
      </div>
      {zipError && <p className="text-sm text-red-600 dark:text-red-400">{zipError}</p>}
      <ul className="flex flex-col divide-y divide-ms-border">
        {rows.map((row, i) => (
          <li key={i} data-testid="batch-row" data-status={row.status} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[row.status]}`}>
              {STATUS_LABEL[row.status]}
            </span>
            <span className="min-w-0 flex-1 truncate text-ms-text" title={row.sourceName}>
              {row.sourceName}
            </span>
            {row.status === "done" && row.blob && row.outputName && (
              <>
                <button
                  type="button"
                  onClick={() => downloadBlob(row.blob!, row.outputName!)}
                  aria-label={`${row.outputName}を保存`}
                  className="shrink-0 rounded-md border border-ms-border px-3 py-1 text-xs font-medium text-ms-text hover:bg-ms-hover-tint"
                >
                  保存
                </button>
                {/* サイズなどの補足は2行目に出す（スマホでもファイル名が隠れないように） */}
                <span className="basis-full text-xs text-ms-muted">
                  {formatBytes(row.blob.size)}
                  {row.detail ? ` ・ ${row.detail}` : ""}
                </span>
              </>
            )}
            {row.status === "error" && (
              <span className="basis-full text-xs text-red-600 dark:text-red-400">{row.error ?? "処理に失敗しました"}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
