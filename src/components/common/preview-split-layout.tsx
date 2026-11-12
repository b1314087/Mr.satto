import type { ReactNode } from "react";
import { PreviewFullscreenFrame } from "./preview-fullscreen";

/**
 * 「設定を操作しながら、プレビューを見続けられる」2カラムの共通レイアウト。
 *
 * - PC幅(lg以上): 左に設定(children)、右にプレビュー(preview)。プレビューは画面に固定(sticky)され、
 *   設定を下までスクロールしても見え続ける。プレビューが画面より高いときは、枠の中でスクロールできる。
 * - プレビューがまだ無いとき（ファイルを選ぶ前など）は、右の列を空けず、左の入力欄を全幅に広げる。
 * - スマホ幅: これまでどおり、設定 → プレビューの順に縦へ並べる(固定しない)。
 * - after（任意）: プレビューを見てから行う操作（PDF出力など）。PCでは左の列の設定の下、
 *   スマホではプレビューの下に置く。手順の番号（…→プレビュー→出力）と、画面の並びを、PC・スマホの両方で一致させるため。
 *
 * 使い方: 設定やボタンなど「操作する部分」を children に、プレビュー部分を preview に渡す。
 * プレビュー側に data-testid="tool-preview" を付ける構造は、そのまま preview の中に置く。
 * プレビューには「大きく表示」（画面いっぱい）のボタンが付く（PreviewFullscreenFrame）。
 */
export function PreviewSplitLayout({
  preview,
  children,
  after,
  previewWidth = "md",
  mobileSticky = false,
}: {
  /** 右側(スマホでは下)に固定表示するプレビュー */
  preview: ReactNode;
  /** 左側(スマホでは上)の、設定・入力・ボタンなど */
  children: ReactNode;
  /** プレビューの後に行う操作（PDF出力など）。PCでは左の列の下、スマホではプレビューの下 */
  after?: ReactNode;
  /** プレビュー列の幅。sm=細め / md=標準 / lg=広め(画像など大きいプレビュー向け) */
  previewWidth?: "sm" | "md" | "lg";
  /**
   * スマホでも、設定を変えながらプレビューを見続けられるようにする（総合改修 3-4）。
   * プレビューを設定より上に置き、画面の上に固定する（高さは画面の4割まで。中はスクロールできる）。
   * 位置や色を動かして結果を見るツール（文字入れ・透かしなど）向け。
   */
  mobileSticky?: boolean;
}) {
  const cols =
    previewWidth === "sm"
      ? "lg:grid-cols-[minmax(0,1fr)_minmax(260px,340px)]"
      : previewWidth === "lg"
        ? "lg:grid-cols-[minmax(0,1fr)_minmax(360px,560px)]"
        : "lg:grid-cols-[minmax(0,1fr)_minmax(300px,440px)]";
  // プレビューがまだ無いとき（ファイルを選ぶ前など）は、右の空の列を空けず、左の入力欄をカードいっぱいに広げる
  const hasPreview = preview !== null && preview !== undefined && preview !== false && preview !== "";
  if (!hasPreview) {
    return (
      <div className="grid grid-cols-1 gap-6" data-preview-split data-preview-empty>
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
        {after && <div className="flex min-w-0 flex-col gap-6">{after}</div>}
      </div>
    );
  }
  if (after) {
    // PC：左の列に「設定」と「出力」を上下に、右の列にプレビューを2段ぶち抜きで置く。
    // 2段目を 1fr にして、プレビューが高いときの余りを2段目（出力の下）に回す（設定と出力の間を空けない）。
    // スマホ：HTMLの順（設定 → プレビュー → 出力）にそのまま並ぶ。
    return (
      <div className={`grid grid-cols-1 gap-6 ${cols} lg:grid-rows-[auto_1fr] lg:items-start`} data-preview-split>
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-1">{children}</div>
        <div className="min-w-0 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto">
          <PreviewFullscreenFrame>{preview}</PreviewFullscreenFrame>
        </div>
        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-2" data-preview-after>
          {after}
        </div>
      </div>
    );
  }
  const mobile = mobileSticky
    ? "max-lg:order-first max-lg:sticky max-lg:top-14 max-lg:z-20 max-lg:max-h-[42vh] max-lg:self-start max-lg:overflow-y-auto max-lg:rounded-xl max-lg:bg-[var(--ms-surface-glass-solid)] max-lg:shadow-md max-lg:backdrop-blur"
    : "";
  return (
    <div className={`grid grid-cols-1 gap-6 ${cols} lg:items-start`} data-preview-split data-mobile-sticky={mobileSticky || undefined}>
      <div className="flex min-w-0 flex-col gap-6">{children}</div>
      <div className={`min-w-0 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:self-start lg:overflow-y-auto ${mobile}`}>
        {/* 「大きく表示」で、プレビューを画面いっぱいに広げられる（全ツール共通） */}
        <PreviewFullscreenFrame>{preview}</PreviewFullscreenFrame>
      </div>
    </div>
  );
}
