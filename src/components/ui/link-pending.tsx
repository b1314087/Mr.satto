"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "@/components/ui/spinner";

/**
 * リンク（<Link>）を押してから、次のページの準備ができるまでの「読み込み中」の合図。
 *
 * <Link> の中（子孫）に置くと、そのリンクの移動が待たされている間だけ、
 * リンクの上に半透明の膜とスピナーが重なる。カード全体がリンクになっている一覧
 * （ツールのカード・カテゴリのカード）で使う。
 *
 * - 親の <Link> に `relative` を付けておくこと（膜を、カードの大きさにぴったり重ねるため）。
 * - 常に描画して不透明度だけを切り替えるので、表示が変わっても配置は動かない。
 * - 移動が一瞬で終わる（先読み済みの）ときは、ほとんど見えないうちに画面が切り替わる。
 * - スクリーンリーダーには、待っている間だけ「読み込み中」と伝える。
 */
export function LinkPendingOverlay() {
  const { pending } = useLinkStatus();
  return (
    <>
      {/* 押している間、カードの縁に沿って光が一周する（ボタンの処理中と同じ表示） */}
      <LinkPendingBody pending={pending} />
      <span aria-hidden="true" data-testid="link-glow" data-pending={pending ? "true" : "false"} className="ms-link-glow" />
    </>
  );
}

function LinkPendingBody({ pending }: { pending: boolean }) {
  return (
    <span
      aria-hidden={pending ? undefined : true}
      data-testid="link-pending"
      data-pending={pending ? "true" : "false"}
      className="ms-link-pending pointer-events-none absolute inset-0 flex items-center justify-center rounded-[inherit]"
    >
      {pending && (
        <span role="status" className="flex items-center gap-2 text-sm font-medium text-ms-text">
          <Spinner className="text-ms-accent dark:text-ms-focus" />
          <span>読み込み中...</span>
        </span>
      )}
    </span>
  );
}
