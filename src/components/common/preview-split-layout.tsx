import type { ReactNode } from "react";

/**
 * 「設定を操作しながら、プレビューを見続けられる」2カラムの共通レイアウト。
 *
 * - PC幅(lg以上): 左に設定(children)、右にプレビュー(preview)。プレビューは画面に固定(sticky)され、
 *   設定を下までスクロールしても見え続ける。プレビューが画面より高いときは、枠の中でスクロールできる。
 * - スマホ幅: これまでどおり、設定 → プレビューの順に縦へ並べる(固定しない)。
 *
 * 使い方: 設定やボタンなど「操作する部分」を children に、プレビュー部分を preview に渡す。
 * プレビュー側に data-testid="tool-preview" を付ける構造は、そのまま preview の中に置く。
 */
export function PreviewSplitLayout({
  preview,
  children,
  previewWidth = "md",
}: {
  /** 右側(スマホでは下)に固定表示するプレビュー */
  preview: ReactNode;
  /** 左側(スマホでは上)の、設定・入力・ボタンなど */
  children: ReactNode;
  /** プレビュー列の幅。sm=細め / md=標準 / lg=広め(画像など大きいプレビュー向け) */
  previewWidth?: "sm" | "md" | "lg";
}) {
  const cols =
    previewWidth === "sm"
      ? "lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]"
      : previewWidth === "lg"
        ? "lg:grid-cols-[minmax(0,1fr)_minmax(360px,560px)]"
        : "lg:grid-cols-[minmax(0,1fr)_minmax(300px,440px)]";
  return (
    <div className={`grid grid-cols-1 gap-6 ${cols} lg:items-start`} data-preview-split>
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
      <div className="min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
        {preview}
      </div>
    </div>
  );
}
