import type { Page } from "@playwright/test";

/**
 * 座席表の右のメニュー：2026-11 から、設定はプルダウンで切り替えず、すべて縦に並べていつも表示する。
 * 以前のテストとの互換のために残している（プルダウンが無いときは何もしない）。
 */
export type SeatPanel = "purpose" | "layout" | "names" | "marks" | "conditions";

const PREFIX_TO_PANEL: [RegExp, SeatPanel][] = [
  [/^seat-purpose-/, "purpose"],
  [/^seat-(settings|title|per-side|head|front|sides|tables|per-table|deal|group-|table-label|cols|rows|by-column|start|autofit|custom-|desk)/, "layout"],
  [/^seat-(names|import|count|shortage|numbers|furigana|reading-(editor|list|missing|paste))/, "names"],
  [/^seat-(show-marks|locked-count|marks-section)/, "marks"],
  [/^seat-(conditions|rule)/, "conditions"],
];

export function seatPanelOf(testId: string): SeatPanel | null {
  return PREFIX_TO_PANEL.find(([re]) => re.test(testId))?.[1] ?? null;
}

export async function openSeatPanel(page: Page, panelOrTestId: SeatPanel | string): Promise<void> {
  const panel = (["purpose", "layout", "names", "marks", "conditions"] as string[]).includes(panelOrTestId) ? (panelOrTestId as SeatPanel) : seatPanelOf(panelOrTestId);
  if (!panel) return;
  const select = page.getByTestId("seat-panel");
  if ((await select.count()) === 0) return;
  if ((await select.inputValue()) !== panel) await select.selectOption(panel);
}
