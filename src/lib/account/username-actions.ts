"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth/user";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import { isUsernameTaken } from "@/lib/auth/username-store";
import { USERNAME_TAKEN_MESSAGE, validateUsername } from "@/lib/auth/username";
import { checkRateLimit } from "@/lib/utils/rate-limit";

/**
 * ユーザー名の設定・変更（Server Action）。本人だけが、自分のユーザー名を変えられる。
 * 対象のユーザーIDは、フォームから受け取らず、検証済みのセッション（getCurrentUser）から得る。
 * 既存の会員（登録時にユーザー名がなかった方）も、ここから設定する。
 */
export interface UsernameActionState {
  status: "idle" | "saved" | "error";
  message?: string;
}

const USERNAME_RATE_LIMIT = { limit: 10, windowMs: 10 * 60_000 };

export async function setUsernameAction(_prev: UsernameActionState, formData: FormData): Promise<UsernameActionState> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", message: "ログインが必要です。" };

  const checked = validateUsername(formData.get("username"));
  if (!checked.ok) return { status: "error", message: checked.message };

  if (checkRateLimit(`username:${user.id}`, USERNAME_RATE_LIMIT).limited) {
    return { status: "error", message: "操作が多すぎます。しばらくしてから、もう一度お試しください。" };
  }

  const service = getSupabaseServiceClient();
  if (!service) return { status: "error", message: "現在、ユーザー名を保存できません。しばらくしてから、もう一度お試しください。" };

  try {
    if (await isUsernameTaken(service, checked.username, user.id)) return { status: "error", message: USERNAME_TAKEN_MESSAGE };
  } catch {
    return { status: "error", message: "ユーザー名を確認できませんでした。しばらくしてから、もう一度お試しください。" };
  }

  const { error } = await service.from("profiles").update({ username: checked.username, updated_at: new Date().toISOString() }).eq("id", user.id);
  if (error) {
    // 同時に同じ名前を取られた場合（一意制約）
    if (error.code === "23505") return { status: "error", message: USERNAME_TAKEN_MESSAGE };
    return { status: "error", message: "ユーザー名を保存できませんでした。しばらくしてから、もう一度お試しください。" };
  }
  revalidatePath("/account");
  return { status: "saved", message: "ユーザー名を保存しました。" };
}
