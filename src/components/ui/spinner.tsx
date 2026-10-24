import { cn } from "@/lib/utils/cn";

/**
 * 処理中のスピナー（UI刷新・第4工程）。見た目は src/app/globals.css の .ms-spinner。
 * 文字（「処理中...」など）と一緒に使う前提の飾りなので、スクリーンリーダーには読ませない。
 * 「視覚効果を減らす」設定では回らず、静止した輪になる（文字で処理中だと分かる）。
 * 進捗率は表示しない（実際に測れていない値を見せないため）。
 */
export function Spinner({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn("ms-spinner", className)} />;
}
