"use client";

import { useEffect, useRef } from "react";
import { GuideFigure } from "@/components/guide/guide-figure";
import { toolGuides } from "@/lib/guides/tool-guides";
import { describeStep } from "@/lib/guides/describe";

/**
 * 「使い方」のスライド（1ページに1手順。左に図、右に見出しと説明）。
 * 幕（src/components/tools/tool-guide.tsx）を初めて開いたときに読み込む。
 * - 「戻る」「次へ」・ページの点・キーボードの←→・横スワイプでページを移る。最後のページは「わかった」で閉じる。
 * - PC用とスマホ用の図を両方描き、どちらを見せるかは CSS（.gd-fig-pc / .gd-fig-sp）で画面の幅に合わせる。
 * ページ番号は親が持つ（幕の右上の「1 / 4」と合わせるため）。
 */
export function ToolGuideSlides({
  toolId,
  howTo,
  index,
  onIndex,
  onDone,
  active,
}: {
  toolId: string;
  howTo: string[];
  index: number;
  onIndex: (i: number) => void;
  onDone: () => void;
  /** 使い方のスライドが見えているか（キーボードの←→を受け付けるか） */
  active: boolean;
}) {
  const guide = toolGuides[toolId];
  const steps = guide?.steps ?? [];
  const count = steps.length;
  const touch = useRef<{ x: number; y: number } | null>(null);

  // キーボードの←→でページを移る
  useEffect(() => {
    if (!active || count === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.key === "ArrowRight") {
        e.preventDefault();
        onIndex(Math.min(count - 1, index + 1));
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        onIndex(Math.max(0, index - 1));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, count, index, onIndex]);

  // 図のデータがないとき（通常はない）は、文章の手順を出す
  if (count === 0) {
    return (
      <ol className="ms-guide-steps-text">
        {howTo.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    );
  }

  const last = index === count - 1;

  return (
    <div className="gd-slider" data-testid="guide-figures">
      <div
        className="gd-viewport"
        onTouchStart={(e) => {
          const t = e.touches[0];
          touch.current = { x: t.clientX, y: t.clientY };
        }}
        onTouchEnd={(e) => {
          const start = touch.current;
          touch.current = null;
          if (!start) return;
          const t = e.changedTouches[0];
          const dx = t.clientX - start.x;
          const dy = t.clientY - start.y;
          if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
          onIndex(dx < 0 ? Math.min(count - 1, index + 1) : Math.max(0, index - 1));
        }}
      >
        <ol className="gd-slides-track" style={{ transform: `translateX(-${index * 100}%)` }}>
          {steps.map((step, i) => {
            const label = `手順${i + 1}：${step.title}`;
            const current = i === index;
            return (
              <li
                key={i}
                className="gd-slide"
                data-testid="guide-step"
                data-current={current ? "true" : undefined}
                aria-hidden={!current}
                inert={!current}
                aria-roledescription="スライド"
                aria-label={`${i + 1} / ${count}`}
              >
                <div className="gd-stage">
                  <div className="gd-fig-pc">
                    <GuideFigure step={step} index={i} variant="pc" split={guide.split} title={label} />
                  </div>
                  <div className="gd-fig-sp">
                    <GuideFigure step={step} index={i} variant="sp" split={guide.split} title={label} />
                  </div>
                </div>
                <div className="gd-copy">
                  <p className="gd-step-no" aria-hidden="true">
                    {i + 1}
                  </p>
                  <h3 className="gd-title">{step.title}</h3>
                  <p className="gd-desc">{describeStep(step)}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="gd-nav">
        <button
          type="button"
          className="ms-guide-pill"
          onClick={() => onIndex(Math.max(0, index - 1))}
          disabled={index === 0}
          data-testid="guide-prev"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
            <path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          戻る
        </button>
        <div className="gd-dots" role="group" aria-label="ページ">
          {steps.map((step, i) => (
            <button
              key={i}
              type="button"
              className="gd-dot"
              aria-label={`${i + 1}ページ目：${step.title}`}
              aria-current={i === index ? "step" : undefined}
              onClick={() => onIndex(i)}
            />
          ))}
        </div>
        {last ? (
          <button type="button" className="ms-guide-pill ms-guide-pill-primary" onClick={onDone} data-testid="guide-done">
            <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
              <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5.3 8.2l1.8 1.8 3.6-3.8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            わかった
          </button>
        ) : (
          <button
            type="button"
            className="ms-guide-pill ms-guide-pill-primary"
            onClick={() => onIndex(Math.min(count - 1, index + 1))}
            data-testid="guide-next"
          >
            次へ
            <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
              <path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

/** 手順の数（幕の右上の「1 / 4」に使う） */
export function guideStepCount(toolId: string): number {
  return toolGuides[toolId]?.steps.length ?? 0;
}
