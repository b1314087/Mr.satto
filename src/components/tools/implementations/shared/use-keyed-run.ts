"use client";

import { useEffect, useRef, useState } from "react";
import type { ProcessingState } from "@/components/common/processing-status";

interface RunState<T> {
  key: string;
  status: ProcessingState;
  error: string | null;
  value: T | null;
}

/**
 * 「実行する」の状態（処理中・成功・失敗・結果）を、実行したときの設定（settingKey）と一緒に持つ。
 * いまの設定と違う古い結果・古いエラーは、表示もダウンロードもできない（status は idle に戻る）。
 * 例: 削除するページを変えたのに、前の削除結果をダウンロードしてしまう、を防ぐ。
 * 設定が変わってから終わった古い実行の結果は、新しい実行を上書きしないよう捨てる。
 *
 * dispose: 結果が不要になったとき（差し替え・画面を閉じるとき）に呼ぶ後始末（Object URLの解放など）。
 */
export function useKeyedRun<T>(settingKey: string, options?: { dispose?: (value: T) => void }) {
  const [state, setState] = useState<RunState<T> | null>(null);
  const runId = useRef(0);
  const disposeRef = useRef(options?.dispose);
  useEffect(() => {
    disposeRef.current = options?.dispose;
  });

  const heldValue = state?.value ?? null;
  useEffect(() => {
    return () => {
      if (heldValue !== null) disposeRef.current?.(heldValue);
    };
  }, [heldValue]);

  const current = state && state.key === settingKey ? state : null;

  async function run(task: () => Promise<T>) {
    const id = ++runId.current;
    const key = settingKey;
    setState({ key, status: "processing", error: null, value: null });
    try {
      const value = await task();
      if (id !== runId.current) {
        disposeRef.current?.(value);
        return;
      }
      setState({ key, status: "success", error: null, value });
    } catch (e) {
      if (id !== runId.current) return;
      setState({ key, status: "error", error: e instanceof Error ? e.message : "処理に失敗しました", value: null });
    }
  }

  /** 結果・エラーを捨てる（ファイルを選び直したときなど） */
  function reset() {
    runId.current++;
    setState(null);
  }

  return {
    status: (current?.status ?? "idle") as ProcessingState,
    error: current?.error ?? null,
    value: current?.value ?? null,
    run,
    reset,
  };
}

/** ファイルを区別するための文字列（同じ名前・大きさ・更新日時なら同じファイルとみなす） */
export function fileKey(file: File | null): string {
  return file ? `${file.name}:${file.size}:${file.lastModified}` : "";
}

/** PDF出力（Object URLつき）の後始末。生成したURLは、使わなくなった時点で解放する */
export function revokeOutputUrl(output: { url: string }): void {
  URL.revokeObjectURL(output.url);
}
