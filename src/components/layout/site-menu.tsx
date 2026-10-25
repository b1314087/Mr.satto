"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { SearchBar } from "@/components/tools/search-bar";
import { ThemeToggle } from "@/components/theme/theme-toggle";
import { AuthStatusLink } from "@/components/auth/auth-status-link";
import { dispatchToolsNavigate } from "@/lib/navigation/tools-navigate";
import { BrandMark } from "@/components/ui/brand-mark";
import { CategoryIcon } from "@/components/ui/category-icon";

interface MenuCategory {
  id: string;
  name: string;
  icon: string;
  /** そのカテゴリで使えるツールの数（表示用。省略すると件数は出さない） */
  count?: number;
}

interface SiteMenuProps {
  /** カテゴリ一覧（src/lib/tools/categories.ts をそのまま渡す。ここでは独自に定義しない） */
  categories: MenuCategory[];
  /** 課金機能（料金プラン・ログイン導線）を出すか。featureFlags.billing の値 */
  showBilling: boolean;
  /** サービス名（siteConfig.shortName） */
  siteName: string;
  /** 使えるツールの総数（「全ツール一覧」の横に出す。省略すると出さない） */
  totalCount?: number;
}

/**
 * 全ページ共通のメニュー（ハンバーガーボタン＋左から開くドロワー）と、狭い画面用の検索ボタン。
 *
 * 設計メモ:
 * - ドロワーは <dialog> を showModal() で開く。ブラウザ標準の機能で、
 *   「開いている間は背後のページを操作できない」「Escapeで閉じる」「Tabの移動がドロワー内に収まる」
 *   「閉じたら開いたボタンへフォーカスが戻る」を自前のコードなしで満たせる。
 * - 開閉の状態はこの部品の中だけで持つ。ページ本文（ツール画面）の状態とは結びつけておらず、
 *   メニューの開閉でルート遷移もページの再生成も起きない（入力中のJSONや変換結果は消えない）。
 * - 中身は開いている間だけ描画する。閉じている時に同じリンクが二重にDOMにある状態を避けるため。
 * - フラグメントで返し、親（Header）の flex の中で order クラスで並べる。
 */
export function SiteMenu({ categories, showBilling, siteName, totalCount }: SiteMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusSearch, setFocusSearch] = useState(false);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const pathname = usePathname();
  const titleId = useId();
  const dialogId = useId();

  function openMenu(withSearch: boolean) {
    // 選択中のカテゴリは /tools?category=... のURLから読む（イベント内で読むので描画には影響しない）
    setActiveCategory(new URLSearchParams(window.location.search).get("category"));
    setFocusSearch(withSearch);
    setOpen(true);
  }

  const close = useCallback(() => setOpen(false), []);

  // <dialog> の開閉を state に合わせる。開いている間は背後のページのスクロールも止める。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) {
        dialog.showModal();
        if (focusSearch) searchRef.current?.focus();
      }
      document.documentElement.classList.add("ms-scroll-lock");
      return () => document.documentElement.classList.remove("ms-scroll-lock");
    }
    if (dialog.open) dialog.close();
  }, [open, focusSearch]);

  /** パネル内でリンクが選ばれたら閉じる。/tools へ行く場合は、一覧の絞り込みも合わせてもらう */
  function handlePanelClick(e: React.MouseEvent<HTMLDivElement>) {
    const anchor = (e.target as HTMLElement).closest("a");
    if (!anchor) return;
    // 新しいタブで開く操作（Ctrl/⌘クリックなど）の時は、このページに留まるので閉じない
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const href = anchor.getAttribute("href");
    if (href) dispatchToolsNavigate(href);
    close();
  }

  /**
   * Tabで最後の項目から先へ進んだ時にブラウザ本体（アドレスバーなど）へ抜けてしまわないよう、
   * ドロワーの先頭・末尾でフォーカスを折り返す。
   */
  function handlePanelKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const focusables = Array.from(
      e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'),
    ).filter((el) => el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  const isCurrent = (href: string) => pathname === href;

  return (
    <>
      <button
        type="button"
        aria-label="メニューを開く"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={() => openMenu(false)}
        className="ms-icon-btn order-6"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" className="h-5 w-5">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* 狭い画面では検索欄を置けないので、ボタンからメニューを開いて検索欄へ移る */}
      <button
        type="button"
        aria-label="ツールを検索"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        onClick={() => openMenu(true)}
        className="ms-icon-btn order-5 ml-auto sm:hidden"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5">
          <path d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
        </svg>
      </button>

      <dialog
        id={dialogId}
        ref={dialogRef}
        aria-labelledby={titleId}
        className="ms-drawer"
        onClose={() => setOpen(false)}
        // ドロワーの外（半透明の背景部分）をクリックしたら閉じる
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      >
        {open && (
          <div className="ms-drawer-panel" onClick={handlePanelClick} onKeyDown={handlePanelKeyDown}>
            <div className="flex items-center justify-between gap-2">
              <h2 id={titleId} className="flex items-center gap-2 text-base font-bold text-ms-text">
                <BrandMark size={28} />
                <span className="sr-only">メニュー</span>
                <span aria-hidden="true">{siteName}</span>
              </h2>
              <button type="button" aria-label="メニューを閉じる" onClick={close} className="ms-icon-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true" className="h-5 w-5">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <SearchBar
              size="lg"
              placeholder="ツールを検索"
              ariaLabel="メニューからツールを検索"
              inputRef={searchRef}
              onNavigate={close}
            />

            <nav aria-label="メインメニュー">
              <ul className="flex flex-col gap-1">
                <li>
                  <Link href="/" className="ms-menu-link" aria-current={isCurrent("/") ? "page" : undefined}>
                    <MenuGlyph>
                      <path d="m3 11 9-7.5L21 11M5.5 9.5V20h13V9.5M10 20v-5.5h4V20" />
                    </MenuGlyph>
                    ホーム
                  </Link>
                </li>
                <li>
                  <Link
                    href="/tools"
                    className="ms-menu-link"
                    aria-current={pathname === "/tools" && !activeCategory ? "page" : undefined}
                  >
                    <MenuGlyph>
                      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
                      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
                      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
                      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
                    </MenuGlyph>
                    全ツール一覧
                    {totalCount !== undefined && (
                      <span aria-hidden="true" className="ms-side-count">
                        {totalCount}
                      </span>
                    )}
                  </Link>
                </li>
              </ul>
            </nav>

            <nav aria-label="カテゴリ">
              <h3 className="mb-1 px-3 text-xs font-semibold text-ms-muted">カテゴリ</h3>
              <ul className="flex flex-col gap-1">
                {categories.map((cat) => (
                  <li key={cat.id}>
                    <Link
                      href={`/tools?category=${cat.id}`}
                      className="ms-menu-link"
                      aria-current={pathname === "/tools" && activeCategory === cat.id ? "page" : undefined}
                    >
                      <CategoryIcon id={cat.id} size="sm" />
                      {cat.name}
                      {cat.count !== undefined && (
                        <span aria-hidden="true" className="ms-side-count">
                          {cat.count}
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>

            <nav aria-label="サービス情報">
              <h3 className="mb-1 px-3 text-xs font-semibold text-ms-muted">サービス情報</h3>
              <ul className="flex flex-col gap-1">
                {showBilling && (
                  <>
                    <li>
                      <Link href="/pricing" className="ms-menu-link" aria-current={isCurrent("/pricing") ? "page" : undefined}>
                        料金プラン
                      </Link>
                    </li>
                    <li>
                      <AuthStatusLink className="ms-menu-link" />
                    </li>
                  </>
                )}
                <li>
                  <Link href="/about" className="ms-menu-link" aria-current={isCurrent("/about") ? "page" : undefined}>
                    {siteName}について
                  </Link>
                </li>
                <li>
                  <Link href="/privacy" className="ms-menu-link" aria-current={isCurrent("/privacy") ? "page" : undefined}>
                    プライバシーポリシー
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="ms-menu-link" aria-current={isCurrent("/terms") ? "page" : undefined}>
                    利用規約
                  </Link>
                </li>
              </ul>
            </nav>

            {/* 狭い画面ではヘッダーにテーマ切り替えを置けないので、ここに出す */}
            <div className="flex items-center justify-between gap-2 px-3 sm:hidden">
              <span className="text-sm text-ms-muted">表示テーマ</span>
              <ThemeToggle />
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}

/** メニューの「ホーム」「全ツール一覧」の先頭に置く、線画アイコン（装飾） */
function MenuGlyph({ children }: { children: React.ReactNode }) {
  return (
    <span aria-hidden="true" className="inline-flex h-8 w-8 flex-none items-center justify-center text-ms-muted">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-5 w-5"
      >
        {children}
      </svg>
    </span>
  );
}
