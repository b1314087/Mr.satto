"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/user";
import { recordCurrentConsents } from "./consent-store";

/**
 * アカウント画面での、現在の利用規約・プライバシーポリシーへの同意（Server Action）。
 * 同意するのは、ログイン中の本人だけ。対象のユーザーIDも、版も、日時も、サーバー側で決める
 * （フォームから受け取るのは、チェックボックスの「同意した」だけ）。
 */
export async function acceptCurrentTermsAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect("/login?next=/account");

  if (formData.get("consent") !== "on") redirect("/account?consent=required");

  const ok = await recordCurrentConsents(user.id, "account");
  redirect(ok ? "/account?consent=done" : "/account?consent=failed");
}
