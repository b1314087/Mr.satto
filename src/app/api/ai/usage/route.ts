import { NextResponse } from "next/server";
import { getAiAvailability, getCaller, getLedger } from "@/lib/ai/server";
import { microUsdToAiTokens } from "@/lib/ai/pricing";

/**
 * AIトークンの使用量・残量（画面表示用）。内部のAPI費用（金額）は返さない。
 * 返す値: 1請求期間の枠・使用済み（処理中を含む）・残り・リセット日（請求期間の終了日）。
 */
const NO_STORE = { "Cache-Control": "no-store" };

type Unavailable = "login_required" | "not_premium" | "unavailable";

function unavailable(reason: Unavailable) {
  return NextResponse.json({ available: false, reason }, { headers: NO_STORE });
}

export async function GET() {
  if (!getAiAvailability().available) return unavailable("unavailable");
  const caller = await getCaller();
  if (!caller.userId) return unavailable("login_required");
  if (caller.plan !== "premium") return unavailable("not_premium");
  const ledger = getLedger(caller.aiLimitMicroUsd);
  if (!ledger) return unavailable("unavailable");
  try {
    const usage = await ledger.getUsage(caller.userId);
    if (!usage.entitled || !usage.period) return unavailable(usage.reason === "not_premium" ? "not_premium" : "unavailable");
    const p = usage.period;
    return NextResponse.json(
      {
        available: true,
        usage: {
          limitAiTokens: microUsdToAiTokens(p.limitMicroUsd),
          usedAiTokens: microUsdToAiTokens(p.spentMicroUsd + p.reservedMicroUsd),
          remainingAiTokens: microUsdToAiTokens(p.remainingMicroUsd),
          periodEnd: p.periodEnd,
        },
      },
      { headers: NO_STORE },
    );
  } catch {
    return unavailable("unavailable");
  }
}
