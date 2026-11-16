import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";

/**
 * 有料プランのアカウント共有対策（パスキー必須・登録端末は最大2台・同時利用は1台）のE2Eテスト。
 *
 * - Chromiumの仮想認証器（WebAuthn）で、本物のWebAuthnの登録・認証を行い、サーバーの検証（チャレンジ・Origin・
 *   RP ID・署名・ユーザー確認）を通す。端末＝ブラウザのコンテキスト（Cookieが別）として扱う。
 * - 同期されたパスキー（iCloudキーチェーン・Googleパスワードマネージャーなど）は、仮想認証器のパスキーを
 *   別のコンテキストの認証器へ複製して再現する。
 * - 保存先は、開発サーバーのメモリ上の実装（src/lib/passkey/dev.ts。PASSKEY_DEV_STORE=memory・開発サーバーのときだけ）。
 *   DB関数の同じ約束は scripts/test-passkey-sql.sh（使い捨てのPostgreSQL）で確かめている。
 *
 * 注意：Apple・Google・Microsoftの実機での確認は、この自動テストではできない（実機での確認手順は報告に書く）。
 */

const PREMIUM_TOOL = "/tools/pdf-to-excel"; // プレミアム限定のツール

async function newDevice(browser: Browser, baseURL: string, userId: string, plan: "free" | "standard" | "premium" = "premium") {
  const context = await browser.newContext();
  const url = new URL(baseURL);
  await context.addCookies([
    { name: "mrsatto-dev-user", value: userId, domain: url.hostname, path: "/" },
    { name: "mrsatto-dev-plan-override", value: plan, domain: url.hostname, path: "/" },
  ]);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page, cdp, authenticatorId };
}

type Device = Awaited<ReturnType<typeof newDevice>>;

/**
 * Aのパスキーを、Bの認証器にも入れる（同期されたパスキーの再現）。
 * 仮想認証器は使うたびに署名カウンターを増やすので、複製したパスキーを使い回すと、カウンターが戻ったと判定される
 * （複製されたパスキーを見抜くための、WebAuthnの正しい動き）。実際の同期パスキー（iCloudキーチェーン・
 * Googleパスワードマネージャー）はカウンターを常に0で送るので、この判定にはかからない。
 * テストでは、使う直前に最新のカウンターを写し直す。
 */
async function syncPasskeys(from: Device, to: Device) {
  const { credentials } = await from.cdp.send("WebAuthn.getCredentials", { authenticatorId: from.authenticatorId });
  await to.cdp.send("WebAuthn.clearCredentials", { authenticatorId: to.authenticatorId });
  for (const c of credentials) {
    await to.cdp.send("WebAuthn.addCredential", { authenticatorId: to.authenticatorId, credential: c });
  }
  return credentials.length;
}

async function openSecurity(page: Page) {
  await page.goto("/account/security");
  await expect(page.getByTestId("passkey-manager")).toBeVisible({ timeout: 60_000 });
  // ボタンがReactにつながるまで待つ（開発サーバーの準備）
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="passkey-manager"] button');
    return !el || Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  });
}

async function status(page: Page) {
  return page.getByTestId("passkey-manager").getAttribute("data-status");
}

async function apiPost(page: Page, action: string, body: unknown = {}) {
  return page.evaluate(
    async ({ action, body }) => {
      const res = await fetch(`/api/passkey/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    { action, body }
  );
}

async function registerPasskey(page: Page) {
  await openSecurity(page);
  await expect.poll(() => status(page)).toBe("needs_passkey");
  await page.getByTestId("passkey-register").click();
  await expect(page.getByTestId("passkey-message")).toContainText("パスキーを登録しました", { timeout: 30_000 });
  await expect.poll(() => status(page), { timeout: 30_000 }).toBe("ok");
}

async function authenticate(page: Page) {
  await openSecurity(page);
  await page.getByTestId("passkey-authenticate").click();
}

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

let contexts: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(contexts.map((c) => c.close().catch(() => undefined)));
  contexts = [];
});

test("新規の有料会員：パスキー登録前はプレミアム機能を使えず、登録するとすぐ使える（契約は有効なまま）", async ({ browser, baseURL }) => {
  const user = randomUUID();
  const a = await newDevice(browser, baseURL!, user);
  contexts.push(a.context);

  // 登録前：プレミアム限定のツールは、申し込みではなく本人確認（パスキーの登録）を案内する
  await a.page.goto(PREMIUM_TOOL);
  const notice = a.page.getByTestId("paid-access-notice");
  await expect(notice).toBeVisible({ timeout: 60_000 });
  await expect(notice).toHaveAttribute("data-status", "needs_passkey");
  await expect(a.page.getByText("プレミアム限定")).toHaveCount(0);
  // AIのAPIなど、サーバー側の判定も無料と同じになる
  const ai = await apiPost(a.page, "auth-options");
  expect(ai.status).toBe(409); // パスキーが未登録なので、本人確認もまだできない

  await registerPasskey(a.page);

  // 登録後：この端末で、プレミアム限定のツールを使える
  await a.page.goto(PREMIUM_TOOL);
  await expect(a.page.getByTestId("paid-access-notice")).toHaveCount(0, { timeout: 60_000 });
  await expect(a.page.getByText("プレミアム限定")).toHaveCount(0);

  // 一覧：パスキー1つ・端末1台（この端末）
  await openSecurity(a.page);
  await expect(a.page.getByTestId("passkey-item")).toHaveCount(1);
  await expect(a.page.getByTestId("device-item")).toHaveCount(1);
  await expect(a.page.getByTestId("device-item")).toContainText("この端末");
});

test("登録したパスキーで別の端末から本人確認すると、2台目として登録され、利用が切り替わる（1台目は止まる）", async ({ browser, baseURL }) => {
  const user = randomUUID();
  const a = await newDevice(browser, baseURL!, user);
  const b = await newDevice(browser, baseURL!, user);
  contexts.push(a.context, b.context);
  await registerPasskey(a.page);
  expect(await syncPasskeys(a, b)).toBe(1);

  // B：未登録の端末 → パスキーで本人確認 → 2台目として登録・利用開始（Aから切り替え）
  await openSecurity(b.page);
  await expect.poll(() => status(b.page)).toBe("needs_device");
  await b.page.getByTestId("passkey-authenticate").click();
  await expect(b.page.getByTestId("passkey-message")).toContainText("別の端末での利用を終了し", { timeout: 30_000 });
  await expect.poll(() => status(b.page), { timeout: 30_000 }).toBe("ok");
  await expect(b.page.getByTestId("device-item")).toHaveCount(2);

  // A：定期確認でロックを失ったことに気づき、案内を出す。サーバーの判定も「別の端末で利用中」になる
  await a.page.goto("/");
  await expect(a.page.getByTestId("paid-session-lost")).toBeVisible({ timeout: 30_000 });
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("in_use_elsewhere");
  await a.page.goto(PREMIUM_TOOL);
  await expect(a.page.getByTestId("paid-access-notice")).toHaveAttribute("data-status", "in_use_elsewhere", { timeout: 60_000 });

  // Aでもう一度本人確認すると、Aに戻る（同時に使えるのは1台）
  await syncPasskeys(b, a);
  await authenticate(a.page);
  await expect.poll(() => status(a.page), { timeout: 30_000 }).toBe("ok");
  await openSecurity(b.page);
  await expect.poll(() => status(b.page)).toBe("in_use_elsewhere");
});

test("3台目は登録できない。1台解除すると、その場で3台目を登録できる", async ({ browser, baseURL }) => {
  const user = randomUUID();
  const a = await newDevice(browser, baseURL!, user);
  const b = await newDevice(browser, baseURL!, user);
  const c = await newDevice(browser, baseURL!, user);
  contexts.push(a.context, b.context, c.context);
  await registerPasskey(a.page);
  await syncPasskeys(a, b);
  await authenticate(b.page);
  await expect.poll(() => status(b.page), { timeout: 30_000 }).toBe("ok");

  // C：本人確認はできるが、端末は上限（指示書の文言で案内）
  await syncPasskeys(b, c);
  await authenticate(c.page);
  await expect(c.page.getByTestId("passkey-message")).toContainText(
    "登録できる端末は最大2台です。新しい端末を登録するには、現在登録されている端末を1台解除してください。",
    { timeout: 30_000 }
  );
  await expect.poll(() => status(c.page)).toBe("needs_device");
  await expect(c.page.getByTestId("device-item")).toHaveCount(2);

  // 1台解除 → 続けてCを登録（本人確認から5分以内なので、もう一度の確認はいらない）
  await c.page.getByTestId("device-revoke").first().click();
  await c.page.getByTestId("device-revoke-confirm").click();
  await expect.poll(() => status(c.page), { timeout: 30_000 }).toBe("ok");
  await expect(c.page.getByTestId("device-item")).toHaveCount(2);
  await expect(c.page.getByTestId("device-item").filter({ hasText: "この端末" })).toHaveCount(1);
});

test("ログアウトすると利用ロックが解除され、期限切れ（スリープ・通信切断）のロックも空く", async ({ browser, baseURL }) => {
  const user = randomUUID();
  const a = await newDevice(browser, baseURL!, user);
  const b = await newDevice(browser, baseURL!, user);
  contexts.push(a.context, b.context);
  await registerPasskey(a.page);
  await syncPasskeys(a, b);

  // スリープ明け：期限が切れても、誰も使っていなければ、Aは定期確認でそのまま続けられる
  expect((await apiPost(a.page, "dev-expire-lease")).status).toBe(200);
  expect((await apiPost(a.page, "heartbeat")).body.status).toBe("ok");

  // Aがログアウト → ロックが解放され、Bの画面では「利用中」ではなくなる（本人確認待ち）
  await a.page.goto("/account");
  await a.page.getByRole("button", { name: "ログアウト" }).click();
  await a.page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
  // テスト用ユーザーのCookieは残るので、Aは「本人確認が必要」になる（ロックはない）
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("needs_verification");
  await openSecurity(b.page);
  await expect.poll(() => status(b.page)).toBe("needs_device");
});

test("未登録のパスキー・改ざんした認証データ・使い回したチャレンジでは本人確認できない", async ({ browser, baseURL }) => {
  const user = randomUUID();
  const a = await newDevice(browser, baseURL!, user);
  contexts.push(a.context);
  await registerPasskey(a.page);

  // ブラウザを閉じた（セッションのCookieが消えた）状態にして、本人確認を求められるようにする
  await a.context.clearCookies({ name: "mrsatto-paid-session" });
  await a.context.clearCookies({ name: "mrsatto-pk-verify" });
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("needs_verification");

  // 署名を改ざんして送る → サーバーの検証で断られる（有料機能は開かない）
  await a.page.route("**/api/passkey/auth-verify", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const sig: string = body.response.response.signature;
    body.response.response.signature = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    await route.continue({ postData: JSON.stringify(body) });
  });
  await a.page.getByTestId("passkey-authenticate").click();
  await expect(a.page.getByTestId("passkey-message")).toContainText("確認できませんでした", { timeout: 30_000 });
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("needs_verification");
  await a.page.unroute("**/api/passkey/auth-verify");

  // 未登録のCredential ID（他人や架空のパスキー）→ 断られる
  const opts = await apiPost(a.page, "auth-options");
  expect(opts.status).toBe(200);
  const forged = await apiPost(a.page, "auth-verify", {
    challengeId: opts.body.challengeId,
    response: { id: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA", rawId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA", type: "public-key", response: {}, clientExtensionResults: {} },
  });
  expect(forged.status).toBe(400);
  expect(String(forged.body.error)).toContain("登録されていません");
  // 同じチャレンジは2回使えない
  const again = await apiPost(a.page, "auth-verify", { challengeId: opts.body.challengeId, response: { id: "x", response: {} } });
  expect(again.status).toBe(400);
  expect(String(again.body.error)).toContain("有効期限");
});

test("クライアント側の値の書き換えでは、端末を増やしたり他人の端末・パスキーを操作したりできない", async ({ browser, baseURL }) => {
  const alice = randomUUID();
  const bob = randomUUID();
  const a = await newDevice(browser, baseURL!, alice);
  const b = await newDevice(browser, baseURL!, bob);
  contexts.push(a.context, b.context);
  await registerPasskey(a.page);
  await registerPasskey(b.page);

  // 端末・セッションのCookieを適当な値に書き換えても、有料機能は開かない
  const host = new URL(baseURL!).hostname;
  const forgedContext = await browser.newContext();
  contexts.push(forgedContext);
  await forgedContext.addCookies([
    { name: "mrsatto-dev-user", value: alice, domain: host, path: "/" },
    { name: "mrsatto-dev-plan-override", value: "premium", domain: host, path: "/" },
    { name: "mrsatto-device", value: "A".repeat(43), domain: host, path: "/" },
    { name: "mrsatto-paid-session", value: "B".repeat(43), domain: host, path: "/" },
    { name: "mrsatto-paid-active", value: "1", domain: host, path: "/" },
  ]);
  const forgedPage = await forgedContext.newPage();
  await openSecurity(forgedPage);
  await expect.poll(() => status(forgedPage)).toBe("needs_device");
  // 本人確認なしでは、端末を登録できない
  const reg = await apiPost(forgedPage, "device-register");
  expect(reg.status).toBe(403);

  // Bobの端末・パスキーのIDを、Aliceは操作できない（本人確認済みでも、見つからない扱い）
  await openSecurity(b.page);
  const bobDevice = await b.page.getByTestId("device-item").count();
  expect(bobDevice).toBe(1);
  // Aliceは登録の直後なので、本人確認（5分以内）は済んでいる
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("ok");
  const fakeId = randomUUID();
  expect((await apiPost(a.page, "device-revoke", { deviceId: fakeId })).status).toBe(404);
  expect((await apiPost(a.page, "credential-delete", { id: fakeId })).status).toBe(404);
  // Bobの画面は何も変わらない
  await openSecurity(b.page);
  await expect(b.page.getByTestId("device-item")).toHaveCount(1);
  await expect(b.page.getByTestId("passkey-item")).toHaveCount(1);
});

test("無料会員にはパスキーを求めない（今までどおり）", async ({ browser, baseURL }) => {
  const a = await newDevice(browser, baseURL!, randomUUID(), "free");
  contexts.push(a.context);
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("not_paid");
  await a.page.goto("/tools/pdf-merge");
  await expect(a.page.getByTestId("paid-access-notice")).toHaveCount(0, { timeout: 60_000 });
});

test("パスキーをすべて削除すると、再登録するまで有料機能は使えない（削除には本人確認が必要）", async ({ browser, baseURL }) => {
  const a = await newDevice(browser, baseURL!, randomUUID());
  contexts.push(a.context);
  await registerPasskey(a.page);
  await openSecurity(a.page);
  await a.page.getByTestId("passkey-delete").click();
  await a.page.getByTestId("passkey-delete-confirm").click();
  await expect(a.page.getByTestId("passkey-message")).toContainText("もう一度登録するまで", { timeout: 30_000 });
  await expect.poll(() => status(a.page), { timeout: 30_000 }).toBe("needs_passkey");
  await a.page.goto(PREMIUM_TOOL);
  await expect(a.page.getByTestId("paid-access-notice")).toHaveAttribute("data-status", "needs_passkey", { timeout: 60_000 });
});

test("12時間たつと本人確認を求め、パスキーで確認すれば続けて使える。パスワード変更のあとは全端末のセッションが終わる", async ({ browser, baseURL }) => {
  const a = await newDevice(browser, baseURL!, randomUUID());
  contexts.push(a.context);
  await registerPasskey(a.page);
  await apiPost(a.page, "dev-age-verification", { seconds: 13 * 3600 });
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("needs_verification");
  await a.page.getByTestId("passkey-authenticate").click();
  await expect.poll(() => status(a.page), { timeout: 30_000 }).toBe("ok");
  // パスワード変更のあとの処理（endAllSessions）：この端末も、もう一度本人確認が必要になる
  await apiPost(a.page, "dev-end-all-sessions");
  await openSecurity(a.page);
  await expect.poll(() => status(a.page)).toBe("needs_verification");
});

test("正式なアドレス以外（別のOrigin）からは、パスキーの操作を受け付けない", async ({ browser, baseURL }) => {
  const a = await newDevice(browser, baseURL!, randomUUID());
  contexts.push(a.context);
  for (const origin of ["https://mrmatto.vercel.app", "https://www.mrsatto.com", "https://evil.example"]) {
    const res = await a.context.request.post(`${baseURL}/api/passkey/register-options`, { headers: { Origin: origin, "Content-Type": "application/json" }, data: {} });
    expect(res.status(), origin).toBe(403);
  }
});

test("新しい端末の登録に、メールの確認コードは求めない（メール認証は導入しない方針）", async ({ browser, baseURL }) => {
  const user = randomUUID();
  const a = await newDevice(browser, baseURL!, user);
  const b = await newDevice(browser, baseURL!, user);
  contexts.push(a.context, b.context);
  await registerPasskey(a.page);
  await syncPasskeys(a, b);
  await authenticate(b.page);
  await expect.poll(() => status(b.page), { timeout: 30_000 }).toBe("ok");
  await expect(b.page.getByTestId("email-step")).toHaveCount(0);
  expect((await apiPost(b.page, "email-send")).status).toBe(404);
});
