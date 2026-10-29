import { test, expect } from "../fixtures/premium-test";

/** 処理中のボタン: 周りを光が一周し、文字の前にスピナーが出る。押せない（二重に押せない） */
test.describe("実行ボタンの動作中の表示", () => {
  test("処理中（aria-busy）のボタンは、光の輪が回り、スピナーが出て、押せない", async ({ page }) => {
    await page.goto("/tools/envelope-address");
    const run = page.getByRole("button", { name: /PDFを作成|作成中/ });
    await expect(run).toBeVisible({ timeout: 40_000 });

    // 強制的に「処理中」の状態にして、見た目の部品を確かめる（実際の処理は一瞬で終わるため）
    await run.evaluate((el) => {
      el.setAttribute("aria-busy", "true");
      el.setAttribute("disabled", "");
    });
    const style = await run.evaluate((el) => {
      const after = getComputedStyle(el, "::after");
      const before = getComputedStyle(el, "::before");
      return {
        ringAnimation: after.animationName,
        ringContent: after.content,
        spinnerAnimation: before.animationName,
        spinnerContent: before.content,
        cursor: getComputedStyle(el).cursor,
        opacity: getComputedStyle(el).opacity,
      };
    });
    expect(style.ringContent).not.toBe("none");
    expect(style.ringAnimation).toBe("ms-busy-orbit");
    expect(style.spinnerContent).not.toBe("none");
    expect(style.spinnerAnimation).toBe("ms-spin");
    expect(style.cursor).toBe("progress");
    expect(style.opacity).toBe("1"); // 処理中は薄くしない
    await expect(run).toBeDisabled();
  });

  test("動きを減らす設定では、光は回さず、輪を固定で出す", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/tools/envelope-address");
    const run = page.getByRole("button", { name: /PDFを作成|作成中/ });
    await expect(run).toBeVisible({ timeout: 40_000 });
    await run.evaluate((el) => {
      el.setAttribute("aria-busy", "true");
      el.setAttribute("disabled", "");
    });
    const anim = await run.evaluate((el) => getComputedStyle(el, "::after").animationName);
    expect(anim).toBe("none");
    const content = await run.evaluate((el) => getComputedStyle(el, "::after").content);
    expect(content).not.toBe("none");
  });

  test("実際に処理を始めると、押している間だけ aria-busy が付き、終わると外れる（文言も切り替わる）", async ({ page }) => {
    await page.goto("/tools/envelope-address");
    await expect(page.getByTestId("envelope-step-input")).toBeVisible({ timeout: 40_000 });
    await expect(async () => {
      await page.getByLabel("宛先1").fill("〒100-0001\n東京都千代田区千代田1-1\n山田商事");
      await expect(page.getByTestId("tool-preview").locator("svg")).toContainText("東", { timeout: 3000 });
    }).toPass({ timeout: 40_000 });

    // ボタンの aria-busy / 文言の変化を、押す前から記録しておく
    await page.evaluate(() => {
      const w = window as unknown as { __busySeen: string[] };
      w.__busySeen = [];
      const find = () => [...document.querySelectorAll("button")].find((b) => /PDFを作成|作成中/.test(b.textContent ?? ""));
      new MutationObserver(() => {
        const b = find();
        if (b?.getAttribute("aria-busy") === "true") w.__busySeen.push(b.textContent ?? "");
      }).observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
    });
    await page.getByRole("button", { name: "PDFを作成" }).click();
    await expect(page.getByText("封筒PDFを作成しました")).toBeVisible({ timeout: 20_000 });
    const seen = await page.evaluate(() => (window as unknown as { __busySeen: string[] }).__busySeen);
    expect(seen.length, "処理中に aria-busy が付いたこと").toBeGreaterThan(0);
    expect(seen.some((t) => t.includes("作成中"))).toBe(true);
    await expect(page.getByRole("button", { name: "PDFを作成" })).not.toHaveAttribute("aria-busy", "true");
  });
});
