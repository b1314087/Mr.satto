"use client";

import { useEffect, useSyncExternalStore } from "react";

/**
 * ツールの画面で選ばれている操作（モード）を、使い方の幕（src/components/tools/tool-guide.tsx）に知らせる仕組み。
 *
 * PDF編集（結合・分割など）のように、1つの画面でモードを切り替えるツールは、モードが変わるたびに知らせる。
 * 幕を開くと、いま選ばれているモードの使い方の図が出る（統合済みの旧アドレスで開いたときも、そのモードの図）。
 * 幕とツールは別の場所にあるので、ブラウザのイベントでつなぐ（ページの外へは何も送らない）。
 */
export const TOOL_MODE_EVENT = "ms:tool-mode";

let currentMode: string | null = null;

/** いまツールで選ばれているモード（知らせていないツールでは null） */
export function currentToolMode(): string | null {
  return currentMode;
}

function announce(mode: string | null) {
  currentMode = mode;
  window.dispatchEvent(new CustomEvent<string | null>(TOOL_MODE_EVENT, { detail: mode }));
}

/** ツールの中で呼ぶ：モードが変わるたびに幕へ知らせる。ツールが画面から消えたら取り消す */
export function useAnnounceToolMode(mode: string) {
  useEffect(() => {
    announce(mode);
    return () => {
      if (currentMode === mode) announce(null);
    };
  }, [mode]);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(TOOL_MODE_EVENT, onChange);
  return () => window.removeEventListener(TOOL_MODE_EVENT, onChange);
}

/** 幕の中で呼ぶ：いまツールで選ばれているモード（サーバーでの表示と、知らせていないツールでは null） */
export function useToolMode(): string | null {
  return useSyncExternalStore(subscribe, currentToolMode, () => null);
}
