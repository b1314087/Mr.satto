"use client";

import { useEffect } from "react";
import { installBusyHold } from "@/lib/utils/busy-hold";

/**
 * 全ツール共通: 処理中の光を、押してから最低0.6秒は見せ続ける（仕組みは src/lib/utils/busy-hold.ts）。
 * 画面には何も出さない。
 */
export function BusyHold() {
  useEffect(() => installBusyHold(), []);
  return null;
}
