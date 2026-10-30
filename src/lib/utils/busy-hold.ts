/**
 * 「押してから最低 BUSY_MIN_MS だけは、処理中の表示を続ける」ための、全ツール共通の仕組み。
 *
 * 軽い処理は一瞬で終わり、ボタンの周りの光（aria-busy）が見える前に、結果の画面へ切り替わってしまう。
 * そこで、処理中の目印（ボタンの aria-busy="true"）が付いてから BUSY_MIN_MS が経つまでは、
 *   1. ボタンの光（aria-busy）を、外れても付け直して見せ続ける（その間、ボタンは押せない）
 *   2. 「処理中…」の表示（ProcessingStatus）と、完了ポップアップ（ResultPopup）の表示を、その分だけ待たせる
 * 個別のツールは、何も変えなくてよい（処理そのものは待たない。見せ方だけを、少し遅らせる）。
 */
export const BUSY_MIN_MS = 600;

let holdUntil = 0;

/** 処理が始まった（処理中の目印が付いた）ことを記録する */
export function markBusyStart(now: number = Date.now()): void {
  holdUntil = Math.max(holdUntil, now + BUSY_MIN_MS);
}

/** 表示を続けるべき、残りの時間（ミリ秒）。0以下なら待たなくてよい */
export function busyHoldRemaining(now: number = Date.now()): number {
  return Math.max(0, holdUntil - now);
}

/** テスト用: 記録を消す */
export function resetBusyHold(): void {
  holdUntil = 0;
}

/**
 * ボタンの aria-busy を監視して、処理が速く終わっても、BUSY_MIN_MS までは付け直して見せ続ける。
 * 返り値の関数で、監視をやめる。
 */
export function installBusyHold(root: HTMLElement = document.body): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const startedAt = new WeakMap<Element, number>();
  const holding = new Map<Element, ReturnType<typeof setTimeout>>();

  function release(el: Element) {
    const timer = holding.get(el);
    if (timer !== undefined) clearTimeout(timer);
    holding.delete(el);
    el.removeAttribute("data-ms-hold");
    if (el.getAttribute("aria-busy") === "true" && !startedAt.has(el)) el.removeAttribute("aria-busy");
  }

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      const el = rec.target as Element;
      if (rec.attributeName !== "aria-busy" || el.tagName !== "BUTTON") continue;
      const now = Date.now();
      if (el.getAttribute("aria-busy") === "true") {
        // 付け直し（こちらで付けたもの）か、新しく処理が始まったのかを見分ける
        if (holding.has(el)) continue;
        startedAt.set(el, now);
        markBusyStart(now);
        continue;
      }
      // 外れた。処理が始まってから短ければ、付け直して、残りの時間だけ見せる
      const began = startedAt.get(el);
      if (began === undefined) continue;
      startedAt.delete(el);
      const remaining = BUSY_MIN_MS - (now - began);
      if (remaining <= 0 || !el.isConnected) continue;
      el.setAttribute("data-ms-hold", "true");
      el.setAttribute("aria-busy", "true");
      holding.set(
        el,
        setTimeout(() => release(el), remaining),
      );
    }
  });
  observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["aria-busy"] });
  return () => {
    observer.disconnect();
    for (const t of holding.values()) clearTimeout(t);
    holding.clear();
  };
}
