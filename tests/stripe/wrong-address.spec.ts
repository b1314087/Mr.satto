import { test, expect } from "@playwright/test";
import { wrongAddressMessage } from "@/lib/stripe/wrong-address";

/** 古いアドレスで解約・購入を押して断られたとき、正式なアドレスで開き直すよう案内する文のテスト */
test.describe("wrongAddressMessage", () => {
  test("古いアドレスで403なら、正式なアドレスを案内する", () => {
    const msg = wrongAddressMessage(403, "/account", "https://mrmatto.vercel.app", "https://mrsatto.com");
    expect(msg).toContain("https://mrsatto.com/account");
  });
  test("末尾のスラッシュがあっても同じ", () => {
    expect(wrongAddressMessage(403, "/pricing", "https://x.vercel.app", "https://mrsatto.com/")).toContain("https://mrsatto.com/pricing");
  });
  test("正式なアドレスで断られた場合や、403以外では案内しない（別の理由のため）", () => {
    expect(wrongAddressMessage(403, "/account", "https://mrsatto.com", "https://mrsatto.com")).toBeNull();
    expect(wrongAddressMessage(500, "/account", "https://mrmatto.vercel.app", "https://mrsatto.com")).toBeNull();
    expect(wrongAddressMessage(401, "/account", "https://mrmatto.vercel.app", "https://mrsatto.com")).toBeNull();
  });
});
