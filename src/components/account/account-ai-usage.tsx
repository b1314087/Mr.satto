"use client";

import { useEffect, useState } from "react";
import { AiUsageMeter, type AiUsage } from "@/components/tools/implementations/shared/ai-panel-parts";

/**
 * アカウント画面の、AIトークンの残り（プレミアムのみ）。値はAIのツールと同じ /api/ai/usage から読む（金額は出さない）。
 * 読めないとき（AIの準備中・通信の失敗など）は、何も表示しない（推測した値を出さない）。
 */
export function AccountAiUsage() {
  const [usage, setUsage] = useState<AiUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/ai/usage", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { available?: boolean; usage?: AiUsage } | null) => {
        if (!cancelled && data?.available && data.usage) setUsage(data.usage);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!usage) return null;
  return (
    <div data-testid="account-ai-usage">
      <p className="mb-1 text-xs text-ms-muted">AIトークン（今の請求期間）</p>
      <AiUsageMeter usage={usage} />
    </div>
  );
}
