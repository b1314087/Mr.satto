"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { HEARTBEAT_INTERVAL_MS, SESSION_HINT_COOKIE } from "@/lib/passkey/config";

/**
 * 有料プランの同時利用の定期確認（全ページ共通・ブラウザ側）。
 *
 * パスキーで本人確認した端末だけ（目印のCookieがあるときだけ）、1分ごとにサーバーへ利用状態を送り、
 * 同時利用のロックを延長する。別の端末で利用が始まった（ロックを失った）ときは、案内を出し、
 * 画面を読み込み直して、有料機能をロックする（権限はサーバーが判定し直す）。
 *
 * 注意：ブラウザの中だけで動くツールは、すでに始まった処理をこの仕組みで止められないことがある。
 * これは利用を「続けにくくする」ための仕組みで、ブラウザ側の制御だけで不正利用を完全には防げない。
 */
function hasHint(): boolean {
  return typeof document !== "undefined" && document.cookie.split("; ").some((c) => c === `${SESSION_HINT_COOKIE}=1`);
}

export function PaidSessionGuard() {
  const router = useRouter();
  const [lost, setLost] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    async function beat() {
      if (inFlight.current || !hasHint()) return;
      inFlight.current = true;
      try {
        const res = await fetch("/api/passkey/heartbeat", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as { status?: string };
        if (data.status === "lost") {
          setLost(true);
          router.refresh();
        }
      } catch {
        // 通信が切れているときは何もしない（ロックは期限が来れば空く。戻ったときにもう一度確かめる）
      } finally {
        inFlight.current = false;
      }
    }
    void beat();
    const timer = window.setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [router]);

  if (!lost) return null;
  return (
    <div
      role="alert"
      data-testid="paid-session-lost"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-[min(36rem,calc(100%-2rem))] flex-col gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 shadow-lg dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
    >
      <p>別の端末で有料プランの利用が始まったため、この端末での利用を終了しました。この端末で続けて使う場合は、パスキーで本人確認をしてください。</p>
      <div className="flex gap-3">
        <Link href="/account/security" className="ms-btn ms-btn-primary" onClick={() => setLost(false)}>
          本人確認する
        </Link>
        <button type="button" className="ms-btn ms-btn-secondary" onClick={() => setLost(false)}>
          閉じる
        </button>
      </div>
    </div>
  );
}
