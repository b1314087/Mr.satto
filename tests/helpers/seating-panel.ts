import type { Page } from "@playwright/test";

/**
 * 座席表の右のメニュー：2026-11 から、設定は縦に並び、それぞれ見出しを押して開閉できる（用途・鍵の確認・席の条件は最初は閉じている）。
 * テストで設定を操作する前に、その設定の欄を開く。用途を選ぶ前（欄が無いとき）は何もしない。
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
  const details = page.getByTestId(`seat-panel-${panel}`).locator("details").first();
  if ((await details.count()) === 0) return;
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) await details.locator("summary").first().click();
}
