"use client";

import { useEffect, useMemo } from "react";

/**
 * 画像などのプレビュー表示に使う Object URL（blob:...）を、安全に作って解放するための共通フック。
 *
 * 【なぜ必要か】
 * 「レンダー中に URL.createObjectURL → useEffect の後始末で URL.revokeObjectURL」という書き方は、
 * 開発モード（React Strict Mode）で壊れる。Strict Mode は、画面を出した直後に
 * 「後始末 → もう一度セットアップ」を意図的に1回行う。後始末で URL を破棄したあと、
 * 再セットアップでは URL が作り直されない（useMemo の値が残っているため）ので、
 * 破棄済みのURLを <img> が読みにいき、サムネイルが壊れて表示される。
 *
 * 【このフックの方針】
 * - URL は Blob ごとに1つだけ作る（同じ Blob なら何度呼んでも同じ URL。二重に作らない）。
 * - 「いま画面がこの URL を使っている数」を数える。0になっても、その場で破棄せず、
 *   次の1ターン待つ。Strict Mode の「後始末 → 再セットアップ」はその間に終わるので、
 *   使い続けている URL は破棄されない。
 * - 本当に使われなくなった（ファイルが変わった／画面から外れた）URL は、確実に破棄する。
 * - 画面に出なかった（描画だけして使われなかった）URL は、一定時間後に破棄する。
 * - Strict Mode を無効にしたり、revoke を省いたりして回避しているわけではない。
 */

interface Entry {
  url: string;
  /** いま画面（マウント中のコンポーネント）が使っている数 */
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const cache = new WeakMap<Blob, Entry>();

/** 描画だけされて一度も画面に出なかった URL を片付けるまでの時間（ミリ秒） */
const ORPHAN_SWEEP_MS = 30_000;

function discard(blob: Blob, entry: Entry) {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  URL.revokeObjectURL(entry.url);
  if (cache.get(blob) === entry) cache.delete(blob);
}

function scheduleDiscardIfUnused(blob: Blob, entry: Entry, delayMs: number) {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.refs <= 0) discard(blob, entry);
  }, delayMs);
}

/** 同じ Blob には同じ URL を返す（なければ作る）。レンダー中に何度呼ばれても安全 */
export function acquireObjectUrl(blob: Blob): string {
  let entry = cache.get(blob);
  if (!entry) {
    entry = { url: URL.createObjectURL(blob), refs: 0, timer: null };
    cache.set(blob, entry);
    scheduleDiscardIfUnused(blob, entry, ORPHAN_SWEEP_MS);
  }
  return entry.url;
}

/** 画面がこの URL を使い始めた */
export function retainObjectUrl(blob: Blob): void {
  acquireObjectUrl(blob);
  const entry = cache.get(blob)!;
  entry.refs += 1;
  if (entry.timer !== null) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/** 画面がこの URL を使い終わった。誰も使っていなければ、次のターンで破棄する */
export function releaseObjectUrl(blob: Blob): void {
  const entry = cache.get(blob);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs === 0) scheduleDiscardIfUnused(blob, entry, 0);
}

/**
 * Blob（File を含む）の Object URL を返す。blob が null の間は null。
 * blob が変わった／画面から外れたら、前の URL を解放する。
 */
export function useObjectUrl(blob: Blob | null | undefined): string | null {
  const url = useMemo(() => (blob ? acquireObjectUrl(blob) : null), [blob]);
  useEffect(() => {
    if (!blob) return;
    retainObjectUrl(blob);
    return () => releaseObjectUrl(blob);
  }, [blob]);
  return url;
}
