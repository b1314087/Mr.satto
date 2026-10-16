"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRevokeObjectUrlOnChange } from "@/lib/video/use-video-preview";
import { AudioCanceledByUserError } from "@/lib/audio/shared";
import type { ProcessingState } from "@/components/common/processing-status";

/**
 * 音声ツール共通の「実行→進捗→キャンセル→結果」の状態管理。
 * 結果のObject URLは、次の実行・リセット・アンマウント時に自動で解放する。
 */
export function useAudioJob<R extends { url: string }>() {
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [wasCanceled, setWasCanceled] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useRevokeObjectUrlOnChange(result?.url);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setStatus("idle");
    setError(null);
    setProgress(0);
    setWasCanceled(false);
  }, []);

  const run = useCallback(
    async (task: (ctx: { onProgress: (p: number) => void; cancelSignal: AbortSignal }) => Promise<R>) => {
      const controller = new AbortController();
      controllerRef.current = controller;
      setStatus("processing");
      setError(null);
      setResult(null);
      setProgress(0);
      setWasCanceled(false);
      setCanceling(false);
      try {
        const output = await task({ onProgress: setProgress, cancelSignal: controller.signal });
        setResult(output);
        setStatus("success");
      } catch (e) {
        if (e instanceof AudioCanceledByUserError) {
          setWasCanceled(true);
          setStatus("idle");
        } else {
          setError(e instanceof Error ? e.message : "処理に失敗しました");
          setStatus("error");
        }
      } finally {
        setCanceling(false);
        controllerRef.current = null;
      }
    },
    []
  );

  const cancel = useCallback(() => {
    if (!controllerRef.current) return;
    setCanceling(true);
    controllerRef.current.abort();
  }, []);

  return { status, progress, error, setError, result, canceling, wasCanceled, run, cancel, reset };
}
