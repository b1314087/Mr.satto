"use client";

import { useCallback, useEffect, useId, useRef, useState, type ComponentType } from "react";
import type { ToolFaqItem } from "@/lib/seo/tool-content";

/**
 * ツールページの「使い方」「よくある質問」（全ツール共通）。
 *
 * - ツール名の横に2つのボタンを出し、押すと画面の上からパネルが下りてくる（使い方とよくある質問は同じパネルで切り替え）。
 * - 使い方：図（実際の画面の部品と、番号付きの矢印）が中心。図は開いたときに読み込む（ページの最初の読み込みを重くしない）。
 *   文章の手順（検索エンジン向けの説明でもある）は「文章で読む」に入れて、ページのHTMLにはそのまま含める。
 * - よくある質問：文字だけ。質問を押すと答えが開く（いくつでも同時に開ける）。内容は構造化データ（FAQPage）と同じ。
 * - 閉じる：✕・背景・Escキー。開いている間は背景を操作できない（フォーカスはパネルの中だけを回る）。
 *   閉じると、押したボタンにフォーカスが戻る。ツールの入力・ファイル・設定はそのまま（パネルはツールの外にある）。
 * - パネルの中身は、閉じている間もHTMLに含める（読み込みや検索で内容が分かるように）。閉じている間は見えず、操作もできない。
 * 見た目は src/app/globals.css の .ms-guide-*。
 */
type Tab = "howto" | "faq";

type FiguresComponent = ComponentType<{ toolId: string; howTo: string[] }>;

export function ToolGuide({ toolId, toolName, howTo, faq }: { toolId: string; toolName: string; howTo: string[]; faq: ToolFaqItem[] }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("howto");
  const [Figures, setFigures] = useState<FiguresComponent | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const panelId = useId();

  const show = (next: Tab, from: HTMLButtonElement) => {
    returnRef.current = from;
    setTab(next);
    setOpen(true);
  };

  const close = useCallback(() => {
    setOpen(false);
    // 閉じたら、押したボタンにフォーカスを戻す
    requestAnimationFrame(() => returnRef.current?.focus());
  }, []);

  // 使い方の図は、初めて使い方を開いたときに読み込む
  useEffect(() => {
    if (!open || tab !== "howto" || Figures) return;
    let alive = true;
    import("@/components/guide/tool-guide-figures").then((m) => {
      if (alive) setFigures(() => m.ToolGuideFigures);
    });
    return () => {
      alive = false;
    };
  }, [open, tab, Figures]);

  // 開いている間：背景のスクロールを止め、Escで閉じ、フォーカスをパネルの中だけで回す
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('button, summary, a[href], [tabindex]:not([tabindex="-1"])')
      ).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      html.style.overflow = prevOverflow;
    };
  }, [open, close]);

  // タブを切り替えたら、パネルの中を一番上に戻す
  useEffect(() => {
    panelRef.current?.querySelector(".ms-guide-body")?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <>
      <div className="ms-guide-triggers" role="group" aria-label="使い方とよくある質問">
        <button
          type="button"
          className="ms-guide-trigger"
          aria-haspopup="dialog"
          aria-expanded={open && tab === "howto"}
          aria-controls={panelId}
          data-testid="guide-open-howto"
          onClick={(e) => show("howto", e.currentTarget)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
            <rect x="2" y="2.5" width="12" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M5 6h6M5 8.5h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          使い方
        </button>
        <button
          type="button"
          className="ms-guide-trigger"
          aria-haspopup="dialog"
          aria-expanded={open && tab === "faq"}
          aria-controls={panelId}
          data-testid="guide-open-faq"
          onClick={(e) => show("faq", e.currentTarget)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5">
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11.4" r=".9" fill="currentColor" />
          </svg>
          よくある質問
        </button>
      </div>

      <div className="ms-guide-root" data-open={open ? "true" : undefined} inert={!open} aria-hidden={!open}>
        <div className="ms-guide-scrim" onClick={close} aria-hidden="true" data-testid="guide-scrim" />
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="ms-guide-panel"
          data-testid="guide-panel"
        >
          <div className="ms-guide-head">
            <h2 id={titleId} className="ms-guide-title">
              {toolName}
              <span className="sr-only">の{tab === "howto" ? "使い方" : "よくある質問"}</span>
            </h2>
            <button ref={closeRef} type="button" className="ms-guide-close" aria-label="閉じる" data-testid="guide-close" onClick={close}>
              <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="ms-seg ms-seg-wide ms-guide-tabs" role="tablist" aria-label="表示する内容">
            {(
              [
                { id: "howto", label: "使い方" },
                { id: "faq", label: "よくある質問" },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                aria-controls={`${panelId}-${t.id}`}
                data-testid={`guide-tab-${t.id}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="ms-guide-body">
            {/* 使い方：図（開いたときに読み込む）＋文章の手順（HTMLに含める） */}
            <section id={`${panelId}-howto`} role="tabpanel" hidden={tab !== "howto"} aria-label="使い方" data-testid="guide-howto">
              <h3 className="sr-only">使い方</h3>
              {Figures ? (
                <Figures toolId={toolId} howTo={howTo} />
              ) : (
                <div className="ms-guide-loading" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              )}
              <details className="ms-guide-text">
                <summary>文章で読む</summary>
                <ol>
                  {howTo.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </details>
            </section>

            {/* よくある質問：文字だけ。質問を押すと答えが開く（構造化データ FAQPage と同じ内容） */}
            <section id={`${panelId}-faq`} role="tabpanel" hidden={tab !== "faq"} aria-label="よくある質問" data-testid="guide-faq">
              <h3 className="sr-only">よくある質問</h3>
              <div className="ms-guide-faq">
                {faq.map((item) => (
                  <details key={item.question}>
                    <summary>
                      <span className="ms-guide-q" aria-hidden="true">
                        Q
                      </span>
                      <span>{item.question}</span>
                    </summary>
                    <p>
                      <span className="ms-guide-a" aria-hidden="true">
                        A
                      </span>
                      <span>{item.answer}</span>
                    </p>
                  </details>
                ))}
              </div>
            </section>
          </div>
        </div>
      </div>
    </>
  );
}
