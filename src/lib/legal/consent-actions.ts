"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { recordCurrentConsents } from "./consent-store";
import { safeConsentNext } from "./consent";

/**
 * アカウント画面での、現在の利用規約・プライバシーポリシーへの同意（Server Action）。
 * 同意するのは、ログイン中の本人だけ。対象のユーザーIDも、版も、日時も、サーバー側で決める
 * （フォームから受け取るのは、チェックボックスの「同意した」だけ）。
 */
export async function acceptCurrentTermsAction(formData: FormData): Promise<void> {
  // ツールのページから同意したときは、そのツールへ戻る（2026-11-17。戻り先はサイトの中のツール・アカウントだけ）
  const next = safeConsentNext(formData.get("next"));
  const user = await getCurrentUser();
  if (!user) redirect(`/login?next=${next ?? "/account"}`);

  if (formData.get("consent") !== "on") redirect("/account?consent=required");

  const ok = await recordCurrentConsents(user.id, "account");
  if (ok && next) redirect(next);
  redirect(ok ? "/account?consent=done" : "/account?consent=failed");
}
