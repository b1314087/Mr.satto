"use client";

import { useEffect, useRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

/**
 * 共通ダイアログ（UI刷新・第4工程）。広告確認（DownloadGateProvider）など、画面の中央に出す
 * 「確認・案内」用。左から出るメニュー（site-menu.tsx）はブラウザ標準の <dialog> を使う別物で、
 * こちらには含めない。
 *
 * この部品が受け持つこと（呼び出し側が個別に実装しなくてよいように）:
 * - role="dialog" aria-modal="true" と、見出しとの紐づけ（labelledBy）
 * - 開いたらダイアログへフォーカスを移し、閉じたら開く前にいた要素へフォーカスを戻す
 * - Tabキーがダイアログの外へ出ない（先頭・末尾で折り返す）
 * - 開いている間、背後のページがスクロールしない
 * - Escapeで閉じる（onEscape を渡した時だけ。渡さなければ閉じない＝処理中など）
 * - 背景のクリックで閉じる（onBackdropClick を渡した時だけ。誤タップで消えては困る確認画面は渡さない）
 *
 * 何を表示するか・どのボタンで何をするかは、呼び出し側（children）が決める。
 */
export interface ModalProps {
  /** 見出し要素の id（aria-labelledby に使う） */
  labelledBy: string;
  children: ReactNode;
  /** Escapeキーで閉じる時の処理。渡さなければEscapeでは閉じない */
  onEscape?: () => void;
  /** 背景（暗い部分）のクリックで閉じる時の処理。渡さなければ閉じない */
  onBackdropClick?: () => void;
  overlayTestId?: string;
  panelTestId?: string;
  panelProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, string | undefined>;
  className?: string;
}

/** 開いているダイアログの数。ダイアログが重なっても、最後の1つが閉じるまで背後のスクロールを止め続ける */
let openModalCount = 0;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  labelledBy,
  children,
  onEscape,
  onBackdropClick,
  overlayTestId,
  panelTestId,
  panelProps,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onEscapeRef = useRef(onEscape);

  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  // 開いた時: 開く前のフォーカス位置を覚え、背後のスクロールを止め、ダイアログへフォーカスを移す。
  // 閉じた時: 元へ戻す。
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openModalCount += 1;
    document.documentElement.classList.add("ms-scroll-lock");
    // 最初に操作してほしい要素（data-modal-initial-focus）があればそこへ、なければダイアログ自体へ。
    // 開発モードのStrictModeは効果を二重に実行するため、呼び出し側のeffectに任せず、ここで確実に移す。
    const panel = panelRef.current;
    (panel?.querySelector<HTMLElement>("[data-modal-initial-focus]") ?? panel)?.focus();
    return () => {
      openModalCount = Math.max(0, openModalCount - 1);
      if (openModalCount === 0) document.documentElement.classList.remove("ms-scroll-lock");
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // ダイアログが重なっている時（完了ポップアップの上に広告確認が出る時など）は、一番上のものだけがキー操作を受け持つ
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs.length > 1 && dialogs[dialogs.length - 1] !== panelRef.current) return;
      if (event.key === "Escape" && onEscapeRef.current) {
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      const active = document.activeElement;
      // ボタンが無い間（処理中など）や、フォーカスが外へ出てしまった時は、ダイアログ自身へ戻す
      if (focusables.length === 0 || !panel.contains(active)) {
        event.preventDefault();
        (focusables[0] ?? panel).focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div
      className="ms-modal-overlay"
      data-testid={overlayTestId}
      onClick={(e) => {
        if (e.target === e.currentTarget) onBackdropClick?.();
      }}
    >
      <div
        {...panelProps}
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        data-testid={panelTestId}
        className={cn("ms-modal-panel", className)}
      >
        {children}
      </div>
    </div>
  );
}
