"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * ページ移動の「読み込み中」の合図（サイト全体のリンクに共通）。
 *
 * サイト内のリンクを押すと、
 *   1. 画面の上端に細いバーが流れる
 *   2. 押したリンクが、少し薄くなって「処理中」のカーソルになる
 * 次のページの準備ができて、アドレス（パス・クエリ）が変わったら、どちらも消える。
 *
 * - 新しいタブで開くリンク・ダウンロード・外部サイト・同じページ内の移動（ページ内リンク・同じアドレス）では出さない。
 * - Ctrl/⌘/Shift/Alt を押しながらのクリック、右クリックでも出さない（ページが切り替わらないため）。
 * - 万一、移動が起きなかったときのために、一定時間（12秒）で自動的に消す。
 * - 「動きを減らす」設定の人には、バーは動かさず、固定で出す（globals.css）。
 */
const MAX_WAIT_MS = 12_000;

function currentKey(): string {
  return `${window.location.pathname}${window.location.search}`;
}

function NavigationFeedbackInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const key = `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  // 「押した時点のアドレス」。いまのアドレスと同じ間だけ、待っているとみなす（アドレスが変わったら自動で消える）
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = startedAt !== null && startedAt === key;

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      if (anchor.getAttribute("aria-disabled") === "true") return;
      let url: URL;
      try {
        url = new URL(anchor.href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      // 同じアドレス（ページ内リンクのハッシュだけが違う場合も含む）は、ページが切り替わらない
      if (`${url.pathname}${url.search}` === currentKey()) return;

      anchor.setAttribute("data-nav-pending", "true");
      setStartedAt(currentKey());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setStartedAt(null);
        document.querySelectorAll("[data-nav-pending]").forEach((el) => el.removeAttribute("data-nav-pending"));
      }, MAX_WAIT_MS);
    }
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // アドレスが変わった（移動が終わった）ら、押したリンクの印を外す
  useEffect(() => {
    document.querySelectorAll("[data-nav-pending]").forEach((el) => el.removeAttribute("data-nav-pending"));
    if (timer.current) clearTimeout(timer.current);
  }, [key]);

  return (
    <div
      aria-hidden="true"
      data-testid="nav-progress"
      data-pending={pending ? "true" : "false"}
      className="ms-nav-progress"
    />
  );
}

export function NavigationFeedback() {
  // useSearchParams は、Suspense の中に置く必要がある
  return (
    <Suspense fallback={null}>
      <NavigationFeedbackInner />
    </Suspense>
  );
}
