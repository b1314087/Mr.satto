"use client";

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/**
 * つまみ（⋮⋮）をドラッグして、一覧の順番を入れ替える（総合改修 30：動画の順番をドラッグで変える）。
 * マウス・指のどちらでも動く。キーボードや ↑↓ ボタンでの入れ替えは、呼び出し側で別に用意する。
 *
 * 使い方：一覧の各行に data-reorder-index={i} を付け、つまみに handleProps(i) を渡す。
 * ドラッグ中は draggingIndex / overIndex が入るので、見た目（影・線）に使える。
 */
export function useDragReorder(count: number, onMove: (from: number, to: number) => void) {
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const overRef = useRef<number | null>(null);

  function indexAt(clientY: number): number {
    const root = containerRef.current;
    if (!root) return 0;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-reorder-index]"));
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (clientY < r.top + r.height / 2) return i;
    }
    return Math.max(0, rows.length - 1);
  }

  function handleProps(index: number) {
    return {
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
        if (count < 2) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        containerRef.current = e.currentTarget.closest<HTMLElement>("[data-reorder-root]");
        setDraggingIndex(index);
        overRef.current = index;
        setOverIndex(index);
      },
      onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
        if (draggingIndex === null) return;
        const i = indexAt(e.clientY);
        if (i !== overRef.current) {
          overRef.current = i;
          setOverIndex(i);
        }
      },
      onPointerUp: () => {
        if (draggingIndex !== null && overRef.current !== null && overRef.current !== draggingIndex) onMove(draggingIndex, overRef.current);
        setDraggingIndex(null);
        setOverIndex(null);
        overRef.current = null;
      },
      onPointerCancel: () => {
        setDraggingIndex(null);
        setOverIndex(null);
        overRef.current = null;
      },
      style: { touchAction: "none" as const, cursor: count > 1 ? "grab" : "default" },
    };
  }

  return { draggingIndex, overIndex, handleProps };
}

/** 配列の from 番目を to 番目へ動かした新しい配列 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}
