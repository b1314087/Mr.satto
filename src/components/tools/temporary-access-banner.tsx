"use client";

import { useEffect, useState } from "react";

/**
 * Freeユーザーの「広告視聴による1時間の無料利用」の残り時間表示（Phase 4 spec 17章）。
 *
 * 秒単位で常時画面を再描画するとCPUを不必要に消費するため、20秒ごとにのみ
 * 再計算する（分単位の表示なので、この間隔で十分な精度がある）。
 *
 * 重要：このコンポーネントはあくまで表示用であり、期限切れを検知しても
 * 現在レンダリング中の children（ツール本体）を強制的に非表示にしたり、
 * 処理中のファイルを削除したりはしない（Phase 4 spec 18章：進行中のブラウザ処理と
 * 次回利用権の判定を分離する）。実際の再ゲーティングは、次にこのツールページを
 * サーバー側から取得し直した時（ページ遷移・再読み込み）にのみ行われる。
 */
const REFRESH_INTERVAL_MS = 20_000;

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes <= 0) return "まもなく終了します";
  // 1時間の無料利用になったため、60分以上は「1時間」「1時間20分」の形で表示する
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `あと${h}時間` : `あと${h}時間${m}分`;
  }
  return `あと${minutes}分`;
}

export function TemporaryAccessBanner({ expiresAtMs }: { expiresAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const remainingMs = expiresAtMs - now;
  const expired = remainingMs <= 0;

  return (
    <div
      role="status"
      className={`mb-4 rounded-lg border px-4 py-2 text-xs ${
        expired
          ? "border-neutral-300 bg-neutral-50 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400"
          : "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"
      }`}
    >
      {expired
        ? "無料利用時間が終了しました。次にご利用の際は、再度広告をご覧ください。"
        : `無料利用中：${formatRemaining(remainingMs)}`}
    </div>
  );
}
