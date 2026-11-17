/**
 * ゴミ箱のアイコン（選んだファイルなどを「削除する」ボタンに使う。2026-11-17）。
 * 閉じる（×）と区別するため、削除のボタンはこのアイコンにそろえる。
 */
export function TrashIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" data-icon="trash">
      <path d="M4 7h16" />
      <path d="M9 7V4.8c0-.44.36-.8.8-.8h4.4c.44 0 .8.36.8.8V7" />
      <path d="M6.5 7l.9 12.1c.06.78.7 1.4 1.5 1.4h6.2c.8 0 1.44-.62 1.5-1.4L17.5 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}
