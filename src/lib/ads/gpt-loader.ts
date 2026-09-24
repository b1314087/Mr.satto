"use client";

import type { Googletag } from "./gpt-types";

const GPT_SCRIPT_SRC = "https://securepubads.g.doubleclick.net/tag/js/gpt.js";
const GPT_SCRIPT_MARKER = "data-mrsatto-gpt";

let loadPromise: Promise<Googletag> | null = null;

/**
 * Google Publisher Tag (GPT) ライブラリをブラウザへ遅延読み込みする。
 *
 * ページ初期表示を重くしないため、Standard/Premium会員やTemporary Access中の
 * Freeユーザーなど「広告を見る必要がないユーザー」には一切ロードしない。
 * 実際に「広告を見て15分無料で使う」がクリックされた時点で初めて呼び出される
 * （Phase 4 spec 34章：lazy load）。
 *
 * 同時に複数回呼び出されても、スクリプトタグは1つしか挿入しない
 * （呼び出しごとに新しいPromiseを作らず、進行中/完了済みのPromiseを使い回す）。
 */
export function loadGpt(): Promise<Googletag> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("GPT can only be loaded in the browser"));
  }
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<Googletag>((resolve, reject) => {
    const w = window as Window & { googletag?: Googletag };
    w.googletag = w.googletag ?? ({ cmd: [] } as unknown as Googletag);
    const googletag = w.googletag;

    if (document.querySelector(`script[${GPT_SCRIPT_MARKER}]`)) {
      googletag.cmd.push(() => resolve(googletag));
      return;
    }

    const script = document.createElement("script");
    script.src = GPT_SCRIPT_SRC;
    script.async = true;
    script.setAttribute(GPT_SCRIPT_MARKER, "true");
    script.addEventListener("error", () => {
      // 次回リトライできるよう、失敗時はキャッシュをクリアする
      loadPromise = null;
      reject(new Error("Failed to load Google Publisher Tag script"));
    });
    document.head.appendChild(script);
    googletag.cmd.push(() => resolve(googletag));
  });

  return loadPromise;
}
