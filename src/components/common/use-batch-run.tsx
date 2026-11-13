"use client";

import { useState } from "react";
import { BatchResultList, type BatchResultRow } from "@/components/common/batch-result-list";
import { runBatchSequentially, type BatchItem } from "@/lib/batch/run-batch";
import { dedupeFileNames } from "@/lib/utils/format";
import { createZip } from "@/lib/utils/zip";

/**
 * 一括処理（プレミアム）で、1つのファイルを処理した結果。
 * - blob / outputName：結果の一覧の「保存」で保存するファイル。
 * - entries：1つのファイルから複数のファイルができるとき（PDF→画像・タイル分割・ZIP解凍など）の中身。
 *   全体の「ZIPで保存」では、ZIPの中にZIPを入れず、中身を1つずつ入れる。
 */
export interface BatchOutput {
  blob: Blob;
  outputName: string;
  detail?: string;
  entries?: { name: string; blob: Blob }[];
}

/** 一括処理の状態を、結果一覧の行に変換する（書き出すファイル名が重ならないよう番号を付ける） */
export function toBatchResultRows(items: readonly BatchItem<BatchOutput>[]): BatchResultRow[] {
  const names = dedupeFileNames(items.map((item) => item.result?.outputName ?? item.file.name));
  return items.map((item, i) => ({
    sourceName: item.file.name,
    status: item.status,
    outputName: item.result ? names[i] : undefined,
    blob: item.result?.blob,
    detail: item.result?.detail,
    entries: item.result?.entries,
    error: item.error,
  }));
}

/**
 * 複数のファイルを1つずつ順番に処理し、結果の一覧を出すための共通の部品（2026-11 一括処理を15ツールに追加）。
 * 画面ごとに違うのは「1つのファイルをどう処理するか」だけなので、それ以外（状態・進み具合・結果の一覧）をここにまとめる。
 */
export function useBatchRun() {
  const [items, setItems] = useState<BatchItem<BatchOutput>[]>([]);
  const [running, setRunning] = useState(false);

  /** 選んだファイルを1つずつ処理する。返り値は、すべてのファイルの結果 */
  async function run(files: readonly File[], processOne: (file: File, index: number) => Promise<BatchOutput>) {
    setRunning(true);
    try {
      return await runBatchSequentially<BatchOutput>(files, processOne, setItems);
    } finally {
      setRunning(false);
    }
  }

  const finishedCount = items.filter((i) => i.status === "done" || i.status === "error").length;

  return {
    items,
    running,
    run,
    reset: () => setItems([]),
    /** 処理中の表示（「〇〇しています…（2 / 5）」） */
    progressLabel: (verb: string) => `${verb}…（${Math.min(finishedCount + 1, Math.max(items.length, 1))} / ${items.length}）`,
  };
}

/** 一括処理の結果一覧（ファイルごとの状態・1つずつ保存・ZIPでまとめて保存） */
export function BatchRunResults({ items, zipName }: { items: readonly BatchItem<BatchOutput>[]; zipName: string }) {
  if (items.length === 0) return null;
  return <BatchResultList rows={toBatchResultRows(items)} zipName={zipName} />;
}

/** 1つのファイルから複数のファイルができたとき、「保存」用にまとめたZIPを作る（1つだけならそのまま） */
export async function packEntries(entries: { name: string; blob: Blob }[], zipName: string): Promise<BatchOutput> {
  if (entries.length === 1) return { blob: entries[0].blob, outputName: entries[0].name };
  const zip = await createZip(entries);
  return { blob: zip, outputName: zipName, entries };
}

/** 一括処理の結果をまとめて、成功・失敗に合わせた状態と案内を返す */
export function summarizeBatch(items: readonly BatchItem<BatchOutput>[], allFailedMessage: string) {
  const anyDone = items.some((item) => item.status === "done");
  return {
    status: anyDone ? ("success" as const) : ("error" as const),
    error: items.length > 0 && items.every((item) => item.status === "error") ? allFailedMessage : null,
  };
}

/** ファイルの数の言い方（「2つ」「10個」。10以上で「10つ」とならないように） */
export function countFiles(n: number): string {
  return n < 10 ? `${n}つ` : `${n}個`;
}
