"use client";

import { useEffect, useState } from "react";
import { QrCodeProcessor, type QrCodeInput } from "@/lib/processors/browser/qrcode";

export type LiveQrOptions = Omit<QrCodeInput, "text">;

interface LiveQrState {
  key: string;
  dataUrl: string | null;
  error: string | null;
}

/**
 * 入力内容・オプションが変わるたびに二次元コードを再生成して返すフック。
 * プレビューと最終出力で同じ QrCodeProcessor・同じオプションを使う。
 * text が空の場合は null を返す。
 */
export function useLiveQr(text: string, options: LiveQrOptions) {
  const { size, errorCorrectionLevel, darkColor, lightColor, logo } = options;
  const key = JSON.stringify([text, size, errorCorrectionLevel, darkColor, lightColor, logo ?? null]);
  const [state, setState] = useState<LiveQrState | null>(null);

  useEffect(() => {
    if (!text.trim()) return;
    let cancelled = false;
    new QrCodeProcessor()
      .process({ text, size, errorCorrectionLevel, darkColor, lightColor, logo })
      .then((r) => {
        if (!cancelled) setState({ key, dataUrl: r.dataUrl, error: null });
      })
      .catch((e) => {
        if (!cancelled) {
          setState({ key, dataUrl: null, error: e instanceof Error ? e.message : "生成に失敗しました" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [key, text, size, errorCorrectionLevel, darkColor, lightColor, logo]);

  const hasText = text.trim().length > 0;
  // 再生成中は直前の画像を残して、ちらつきを防ぐ(fresh=false の間はダウンロード不可にする)
  const fresh = hasText && state !== null && state.key === key;
  return {
    dataUrl: hasText ? (state?.dataUrl ?? null) : null,
    error: fresh ? state.error : null,
    fresh: fresh && state.dataUrl !== null,
  };
}
