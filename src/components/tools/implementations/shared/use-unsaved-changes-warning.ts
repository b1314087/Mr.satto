"use client";

import { useEffect } from "react";

/**
 * 保存していない編集があるあいだだけ、ブラウザを閉じる・再読み込みする・別のサイトへ移動する直前に、
 * ブラウザ標準の確認（「このサイトを離れますか？」）を出す。
 *
 * - active が false のとき（編集がない、または保存済み）は、何も登録しない。
 * - active が切り替わるたび、また画面が外れたときに、登録を付け外しする（古い状態が残らない）。
 * - 確認の文言は、近年のブラウザでは各ブラウザ固有のものに固定され、こちらからは変えられない。
 * - サイト内のリンク移動（ページ全体を読み込み直さない移動）では、ブラウザ側の仕組み上この確認は出ない。
 *   その場面の保護が必要な画面は、画面ごとに別の確認を用意する。
 */
export function useUnsavedChangesWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      // 確認を出すには、キャンセル可能にする（古い仕様のブラウザのため returnValue も設定する）
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}
