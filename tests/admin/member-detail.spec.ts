import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { isMemberId, memberDetailPath, memberReturnPath, MEMBER_NOTICE_MESSAGES } from "@/lib/admin/member-links";
import { applyActiveGrantToPlan } from "@/lib/plans/grants";

/**
 * 管理画面の会員ページ（一覧は最小限の項目＋会員ごとの詳細ページ）のテスト。
 * 管理者としてログインした状態は、テスト環境では再現できないため、
 * 純粋な処理の単体テストと、実装の静的確認、未ログイン時の保護の確認で守る。
 */
const ID = "123e4567-e89b-42d3-a456-426614174000";

test.describe("会員ページのリンク", () => {
  test("ユーザーIDの形が正しいものだけ、詳細ページのパスになる", () => {
    expect(isMemberId(ID)).toBe(true);
    expect(memberDetailPath(ID)).toBe(`/admin/members/${ID}`);
    expect(memberDetailPath(ID.toUpperCase())).toBe(`/admin/members/${ID}`);
    for (const bad of ["", "abc", "../admin", `${ID}/x`, `${ID}?a=1`, "//evil.com", "https://evil.com"]) {
      expect(memberDetailPath(bad), bad).toBeNull();
    }
  });

  test("操作のあとの戻り先: detail のときだけ詳細ページ、それ以外は一覧（外部のURLへは飛ばさない）", () => {
    expect(memberReturnPath("detail", ID)).toBe(`/admin/members/${ID}`);
    expect(memberReturnPath("list", ID)).toBe("/admin/members");
    expect(memberReturnPath("", ID)).toBe("/admin/members");
    expect(memberReturnPath("https://evil.com", ID)).toBe("/admin/members");
    expect(memberReturnPath("detail", "not-an-id")).toBe("/admin/members");
  });

  test("操作の結果メッセージが揃っている", () => {
    for (const key of ["granted", "revoked", "invalid_date", "invalid", "failed", "not_ready", "forbidden"]) {
      expect(MEMBER_NOTICE_MESSAGES[key], key).toBeTruthy();
    }
  });
});

test.describe("無料付与を加味したプラン", () => {
  test("有効な付与があれば、プレミアムとして表示する。Stripeでプレミアムならそのまま", () => {
    expect(applyActiveGrantToPlan("free", true)).toBe("premium");
    expect(applyActiveGrantToPlan("standard", true)).toBe("premium");
    expect(applyActiveGrantToPlan("free", false)).toBe("free");
    expect(applyActiveGrantToPlan("premium", false)).toBe("premium");
  });
});

test.describe("実装の静的確認", () => {
  const list = readFileSync("src/app/admin/members/page.tsx", "utf8");
  const detail = readFileSync("src/app/admin/members/[id]/page.tsx", "utf8");
  const actions = readFileSync("src/app/admin/members/actions.ts", "utf8");

  test("会員一覧の表の項目は、ユーザー名・メール・プラン・契約状況・ステータス変更・詳細だけ", () => {
    const headers = [...list.matchAll(/<th className="whitespace-nowrap px-4 py-3 font-medium">([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual(["ユーザー名", "メールアドレス", "プラン", "契約状況", "ステータス変更", "詳細"]);
  });

  test("一覧には、詳細ページへ移した項目（Stripe ID・ユーザーID・日付）を出さない", () => {
    for (const word of ["Stripe Customer ID", "ユーザーID", "契約開始日", "次回更新日", "登録日"]) {
      expect(list, word).not.toContain(word);
    }
  });

  test("詳細ページには、一覧から移した項目が揃っている", () => {
    for (const word of ["登録日", "ユーザーID", "契約開始日", "次回更新日", "Stripe Customer ID", "Stripe Subscription ID", "ステータス変更"]) {
      expect(detail, word).toContain(word);
    }
  });

  test("詳細ページはサーバーで管理者を確認してからデータを取得する", () => {
    expect(detail.indexOf("checkAdminAccess()")).toBeGreaterThan(-1);
    expect(detail.indexOf("checkAdminAccess()")).toBeLessThan(detail.indexOf("fetchMemberById("));
  });

  test("ステータス変更の操作は、管理者確認のあとに行い、戻り先は returnTo で決める", () => {
    expect(actions).toContain("memberReturnPath(");
    expect(actions.indexOf("checkAdminAccess()")).toBeLessThan(actions.indexOf("grantPremium("));
    expect(actions.indexOf("checkAdminAccess()")).toBeLessThan(actions.indexOf("revokeGrant("));
  });
});

test.describe("未ログインでは、会員の詳細ページも見えない", () => {
  test("ログイン画面へ移動し、会員の情報は出ない", async ({ page }) => {
    await page.goto(`/admin/members/${ID}`);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByTestId("member-section-contract")).toHaveCount(0);
    await expect(page.getByTestId("member-detail-title")).toHaveCount(0);
  });

  test("形が正しくないIDでも、同じようにログイン画面へ移動する", async ({ page }) => {
    await page.goto("/admin/members/not-an-id");
    await expect(page).toHaveURL(/\/login/);
  });
});
