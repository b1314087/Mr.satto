"use client";

import { useCallback, useEffect, useId, useRef, useState, type ComponentType } from "react";
import type { ToolFaqItem } from "@/lib/seo/tool-content";

/**
 * ツールページの「使い方」「よくある質問」（全ツール共通）。
 *
 * - ツール名の横に2つのボタンを出す。押すと、ガラス調の幕が画面全体に上から下りてくる
 *   （使い方とよくある質問は同じ幕で、上のタブで切り替える。同時には出ない）。
 * - 使い方：1ページに1手順のスライド（左に図、右に見出しと説明）。「戻る」「次へ」・ページの点・←→キー・横スワイプで移り、
 *   最後のページの「わかった」で閉じる。図とスライドの部品は、初めて開いたときに読み込む（ページの最初の読み込みを重くしない）。
 *   文章の手順（検索エンジン向けの説明でもある）は「文章で読む」に入れて、ページのHTMLにはそのまま含める。
 * - よくある質問：文字だけ。質問を押すと答えが開く（いくつでも同時に開ける）。内容は構造化データ（FAQPage）と同じ。
 * - 閉じる：「閉じる」・Escキー・（使い方の最後のページの）「わかった」。開いている間は後ろの画面を操作できない
 *   （フォーカスは幕の中だけを回る）。閉じると、押したボタンにフォーカスが戻る。
 *   幕はツールの外にあるので、開け閉めしてもツールの入力・ファイル・設定はそのまま。
 * - 幕の中身は、閉じている間もHTMLに含める（読み込みや検索で内容が分かるように）。閉じている間は見えず、操作もできない。
 * 見た目は src/app/globals.css の .ms-guide-* と .gd-*。
 */
type Tab = "howto" | "faq";

type SlidesProps = {
  toolId: string;
  howTo: string[];
  index: number;
  onIndex: (i: number) => void;
  onDone: () => void;
  active: boolean;
};
type SlidesModule = { Slides: ComponentType<SlidesProps>; count: (toolId: string) => number };

export function ToolGuide({ toolId, toolName, howTo, faq }: { toolId: string; toolName: string; howTo: string[]; faq: ToolFaqItem[] }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("howto");
  const [page, setPage] = useState(0);
  const [mod, setMod] = useState<SlidesModule | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const returnRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const panelId = useId();

  const show = (next: Tab, from: HTMLButtonElement) => {
    returnRef.current = from;
    setTab(next);
    if (next === "howto") setPage(0);
    setOpen(true);
  };

  const close = useCallback(() => {
    setOpen(false);
    // 閉じたら、押したボタンにフォーカスを戻す
    requestAnimationFrame(() => returnRef.current?.focus());
  }, []);

  // 使い方のスライドは、初めて使い方を開いたときに読み込む
  useEffect(() => {
    if (!open || tab !== "howto" || mod) return;
    let alive = true;
    import("@/components/guide/tool-guide-figures").then((m) => {
      if (alive) setMod({ Slides: m.ToolGuideSlides, count: m.guideStepCount });
    });
    return () => {
      alive = false;
    };
  }, [open, tab, mod]);

  // 開いている間：後ろのスクロールを止め、Escで閉じ、フォーカスを幕の中だけで回す
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = "hidden";
    // 横にスクロールしていたら左端に戻す（幕を画面の左端から出すため）
    if (window.scrollX !== 0) window.scrollTo(0, window.scrollY);
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), summary, a[href], [tabindex]:not([tabindex="-1"])')
      ).filter((el) => el.offsetParent !== null && !el.closest("[inert]"));
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

  // タブを切り替えたら、よくある質問の一覧を一番上に戻す
  useEffect(() => {
    panelRef.current?.querySelector(".ms-guide-faq-scroll")?.scrollTo({ top: 0 });
  }, [tab]);

  const total = mod ? mod.count(toolId) : 0;
  const Slides = mod?.Slides;

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
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle cx="8" cy="11.4" r=".9" fill="currentColor" />
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
          <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
            <path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            <path d="M5.5 7.5h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          よくある質問
        </button>
      </div>

      <div className="ms-guide-root" data-open={open ? "true" : undefined} inert={!open} aria-hidden={!open}>
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
            <div className="ms-guide-heading">
              <span className="ms-guide-mark" aria-hidden="true">
                <svg viewBox="0 0 16 16" className="h-4 w-4">
                  <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M6.3 6.2a1.8 1.8 0 1 1 2.5 1.6c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  <circle cx="8" cy="11.4" r=".9" fill="currentColor" />
                </svg>
              </span>
              <h2 id={titleId} className="ms-guide-title">
                {toolName}
                <span className="sr-only">の{tab === "howto" ? "使い方" : "よくある質問"}</span>
              </h2>
            </div>
            <div className="ms-seg ms-guide-tabs" role="tablist" aria-label="表示する内容">
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
                  onClick={() => {
                    if (t.id === "howto" && tab !== "howto") setPage(0);
                    setTab(t.id);
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="ms-guide-actions">
              {tab === "howto" && total > 0 && (
                <span className="ms-guide-count" data-testid="guide-count">
                  {page + 1} / {total}
                </span>
              )}
              <button ref={closeRef} type="button" className="ms-guide-pill" data-testid="guide-close" onClick={close}>
                <svg viewBox="0 0 16 16" aria-hidden="true" className="h-4 w-4">
                  <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
                </svg>
                閉じる
              </button>
            </div>
          </div>

          {/* 使い方：1ページに1手順のスライド（開いたときに読み込む）＋文章の手順（HTMLに含める） */}
          <section
            id={`${panelId}-howto`}
            role="tabpanel"
            hidden={tab !== "howto"}
            aria-label="使い方"
            className="ms-guide-section ms-guide-howto"
            data-testid="guide-howto"
          >
            {Slides ? (
              <Slides toolId={toolId} howTo={howTo} index={page} onIndex={setPage} onDone={close} active={open && tab === "howto"} />
            ) : (
              <div className="ms-guide-loading" aria-hidden="true">
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
          <section
            id={`${panelId}-faq`}
            role="tabpanel"
            hidden={tab !== "faq"}
            aria-label="よくある質問"
            className="ms-guide-section ms-guide-faq-scroll"
            data-testid="guide-faq"
          >
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
    </>
  );
}
