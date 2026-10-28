"use client";

import { useActionState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
import { deleteAccountAction, type DeleteAccountActionState } from "@/lib/account/delete-account-actions";
import { DELETE_CONFIRMATION_WORD } from "@/lib/account/delete-account";

const INITIAL: DeleteAccountActionState = {};

/** アカウント削除の確認フォーム。確認の文言の入力と、パスワードの再入力を求める（判定はサーバー側） */
export function DeleteAccountForm() {
  const [state, formAction, pending] = useActionState(deleteAccountAction, INITIAL);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5 text-sm">
        パスワード（本人確認のため、もう一度入力してください）
        <input type="password" name="password" required autoComplete="current-password" className="ms-input" />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        確認のため「{DELETE_CONFIRMATION_WORD}」と入力してください
        <input type="text" name="confirmation" required autoComplete="off" className="ms-input" />
      </label>
      <button type="submit" disabled={pending} className="ms-btn ms-btn-secondary w-full">
        {pending ? "削除中..." : "アカウントを完全に削除する"}
      </button>
      {state.error && <ErrorMessage message={state.error} />}
    </form>
  );
}
