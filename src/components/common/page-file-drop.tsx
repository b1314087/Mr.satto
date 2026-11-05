"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  getPageDropServerSnapshot,
  getPageDropSnapshot,
  registerPageDropTarget,
  subscribePageDrop,
  updatePageDropTarget,
  type PageDropTarget,
} from "@/lib/drop/page-file-drop";

/**
 * ファイル選択欄を「ページ全体へのドロップの受け取り先」にする（仕組みは src/lib/drop/page-file-drop.ts）。
 * 受け取り先がページに1つだけのとき、外部のファイルをドラッグしているあいだ、ページ全体に案内を重ねて表示する。
 * 案内はクリックを通す（pointer-events: none）ので、ボタン・リンク・入力欄の操作は妨げない。
 */
export function usePageFileDrop({
  enabled,
  onFiles,
  onReject,
  hint,
}: PageDropTarget & {
  /** false のあいだは受け取り先にしない（補助的な欄・処理中など） */
  enabled: boolean;
  /** 案内に添える短い説明（例：「PDF・1ファイル」） */
  hint?: string;
}) {
  const [id, setId] = useState<number | null>(null);
  const latest = useRef<PageDropTarget>({ onFiles, onReject });

  // 最新の入力処理を使う（登録し直すと受け取り先の順番が変わるため、中身だけ差し替える）
  useEffect(() => {
    latest.current = { onFiles, onReject };
    if (id !== null) updatePageDropTarget(id, latest.current);
  });

  useEffect(() => {
    if (!enabled) return;
    const [registered, unregister] = registerPageDropTarget({
      onFiles: (files) => latest.current.onFiles(files),
      onReject: (message) => latest.current.onReject?.(message),
    });
    // 登録の結果（外部の値）を、表示に反映する
    setId(registered);
    return () => {
      unregister();
      setId(null);
    };
  }, [enabled]);

  const snapshot = useSyncExternalStore(subscribePageDrop, getPageDropSnapshot, getPageDropServerSnapshot);
  const showOverlay = id !== null && snapshot.dragging && snapshot.activeId === id;

  return showOverlay ? createPortal(<PageDropOverlay hint={hint} />, document.body) : null;
}

function PageDropOverlay({ hint }: { hint?: string }) {
  return (
    <div
      data-testid="page-drop-overlay"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[110] flex items-center justify-center bg-ms-page/60 p-4"
    >
      <div className="absolute inset-3 rounded-ms-card border-2 border-dashed border-ms-accent" />
      <div className="relative flex flex-col items-center gap-1 rounded-ms-card bg-ms-strong px-6 py-4 text-center shadow-[var(--ms-shadow-lift)]">
        <p className="text-sm font-semibold text-ms-text">ここにファイルをドロップ</p>
        {hint && <p className="text-xs text-ms-muted">{hint}</p>}
      </div>
    </div>
  );
}
