"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { parseCsv, isBlankRow } from "@/lib/utils/csv";
import { getCsvEncodingChoice, getCsvEncodingVersion, readCsvText, subscribeCsvEncoding } from "@/lib/utils/csv-encoding";

/**
 * ファイル(またはファイルの配列)を非同期に読み込み、結果を「そのファイル用」として保持するフック。
 * ファイルが変わると自動的に「読み込み中」へ戻る(古い結果は表示しない)。
 * loader はモジュール直下の安定した関数を渡すこと(依存配列に入れているため)。
 * CSVの文字コードを画面で選び直したときも、読み直す(選んだ文字コードでプレビューを作り直すため)。
 */
export function useAsyncFileData<K extends File | File[], T>(
  key: K | null,
  loader: (key: K) => Promise<T>
): { data: T | null; error: string | null; loading: boolean } {
  const [state, setState] = useState<{ key: K; version: number; data: T | null; error: string | null } | null>(null);
  const encodingVersion = useSyncExternalStore(subscribeCsvEncoding, getCsvEncodingVersion, () => 0);

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    loader(key)
      .then((data) => {
        if (!cancelled) setState({ key, version: encodingVersion, data, error: null });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({ key, version: encodingVersion, data: null, error: e instanceof Error ? e.message : "ファイルを読み込めませんでした" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, loader, encodingVersion]);

  const current = key && state && state.key === key && state.version === encodingVersion ? state : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    loading: key !== null && current === null,
  };
}

// ---------------------------------------------------------------------------
// CSVの読み込み(プレビュー用)。各ツールのProcessorと同じ読み方(parseCsv + 空行除外)。
// 同じFileは再パースしない。
// ---------------------------------------------------------------------------
// 文字コード(自動判定・選び直し)ごとに覚える。
const csvRowsCache = new WeakMap<File, Map<string, Promise<string[][]>>>();

export function loadCsvRows(file: File): Promise<string[][]> {
  const choice = getCsvEncodingChoice(file);
  let byChoice = csvRowsCache.get(file);
  if (!byChoice) {
    byChoice = new Map();
    csvRowsCache.set(file, byChoice);
  }
  let cached = byChoice.get(choice);
  if (!cached) {
    cached = readCsvText(file, choice).then(
      ({ text }) => {
        const rows = parseCsv(text).filter((row) => !isBlankRow(row));
        if (rows.length === 0) throw new Error("CSVの内容が空です。ファイルを確認してください。");
        return rows;
      },
      () => {
        throw new Error("CSVの内容を読み込めませんでした");
      }
    );
    byChoice.set(choice, cached);
  }
  return cached;
}

/** 複数CSVをまとめて読み込む(CSV結合用) */
export function loadCsvRowSets(files: File[]): Promise<{ name: string; rows: string[][] }[]> {
  return Promise.all(files.map(async (file) => ({ name: file.name, rows: await loadCsvRows(file) })));
}
