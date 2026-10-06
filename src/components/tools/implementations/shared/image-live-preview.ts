"use client";

import { useEffect, useMemo, useState } from "react";
import { loadImage } from "@/lib/processors/browser/image";

/**
 * 画像ツールのライブプレビュー用の共通フック(画像6ツール共用)。
 * 「どのファイルの結果か」を結果と一緒に持ち、描画側で file と比較して導出することで、
 * ファイルが変わった瞬間に古い結果を使わないようにする(effect本体で同期setStateしない)。
 */

/** File の Object URL。ファイルが変わる/外れるたびに解放する */
export function useObjectUrl(file: File | null): string | null {
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => {
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [url]);
  return url;
}

/** File を HTMLImageElement として読み込む。読み込み中は img=null */
export function useLoadedImage(file: File | null): { img: HTMLImageElement | null; error: string | null } {
  const [state, setState] = useState<{ file: File; img: HTMLImageElement | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    loadImage(file).then(
      (img) => {
        if (!cancelled) setState({ file, img, error: null });
      },
      (e) => {
        if (!cancelled) {
          setState({ file, img: null, error: e instanceof Error ? e.message : "画像を読み込めませんでした" });
        }
      }
    );
    return () => {
      cancelled = true;
    };
  }, [file]);
  if (!file || !state || state.file !== file) return { img: null, error: null };
  return { img: state.img, error: state.error };
}

/** 最長辺を maxSide 以下に縮小したCanvasを作る(プレビューを軽くするため) */
export function downscaleToCanvas(img: HTMLImageElement, maxSide: number): HTMLCanvasElement | null {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

/** File を読み込み、縮小したCanvasを返す。読み込み中は null */
export function useDownscaledImage(
  file: File | null,
  maxSide: number
): { canvas: HTMLCanvasElement | null; error: string | null } {
  const { img, error } = useLoadedImage(file);
  const canvas = useMemo(() => (img ? downscaleToCanvas(img, maxSide) : null), [img, maxSide]);
  return { canvas, error };
}
