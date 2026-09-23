/**
 * 軽量な className 結合ヘルパー。
 * clsx 等の外部ライブラリを追加せず、依存を最小限にする（低コスト方針）。
 */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
