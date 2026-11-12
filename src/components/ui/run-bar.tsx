"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * 実行バー（UI・UX改善）。ツールの「実行する」ボタンの置き場所。
 *
 * - ふだんは、設定の下にボタンがあるだけ（今までと同じ位置）。
 * - 設定やプレビューが長くて、ボタンが画面の下に隠れているあいだだけ、画面の下にガラスの帯として
 *   くっついて見える（position: sticky）。ボタンの本来の位置までスクロールすると、元の場所に戻る。
 *   ほかの部品の上に重なるのは、画面の一番下の帯の部分だけ。結果の表示はボタンの下に出るので、覆わない。
 * - 処理中・完了・エラーの表示は、これまでどおり ProcessingStatus・ErrorMessage・完了ポップアップが出す。
 * 見た目は src/app/globals.css の .ms-run-bar。
 */
export function RunBar({ children, note, className }: { children: ReactNode; note?: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    // 帯は画面の下端から1px下にくっつく（bottom: -1px）。くっついている間は、下の1pxだけが画面の外に出る
    // （見える割合が0より大きく1未満で、帯の上端は画面の中）。
    // 本来の位置にあるときは全体が見え（割合1）、上へスクロールして画面の上に出ていくときは、上端が画面の外（top < 0）。
    // ※ isIntersecting は使わない。threshold が [1] だと、割合が1未満のときに false になるブラウザがあり、
    //   くっついた状態をいつまでも検出できなかったため。0 と 1 の両方を境目にして、割合と位置だけで判断する。
    const io = new IntersectionObserver(
      ([entry]) => {
        const rootTop = entry.rootBounds?.top ?? 0;
        setStuck(entry.intersectionRatio > 0 && entry.intersectionRatio < 1 && entry.boundingClientRect.top > rootTop);
      },
      { threshold: [0, 1] }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} className={cn("ms-run-bar", className)} data-stuck={stuck ? "true" : undefined} data-testid="run-bar">
      {children}
      {note && <p className="ms-run-bar-note">{note}</p>}
    </div>
  );
}
