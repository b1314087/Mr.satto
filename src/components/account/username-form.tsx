"use client";

import { useActionState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
import { setUsernameAction, type UsernameActionState } from "@/lib/account/username-actions";
import { USERNAME_MAX_LENGTH, USERNAME_MIN_LENGTH, USERNAME_RULE_HINT } from "@/lib/auth/username";

const INITIAL: UsernameActionState = { status: "idle" };

/** ユーザー名の設定・変更フォーム（アカウント画面）。判定はサーバー側 */
export function UsernameForm({ current }: { current: string | null }) {
  const [state, formAction, pending] = useActionState(setUsernameAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-2" data-testid="username-form">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-xs text-ms-muted">ユーザー名{current ? "" : "（未設定）"}</span>
        <input
          type="text"
          name="username"
          data-testid="account-username"
          defaultValue={current ?? ""}
          required
          minLength={USERNAME_MIN_LENGTH}
          maxLength={USERNAME_MAX_LENGTH}
          autoComplete="username"
          className="ms-input"
        />
      </label>
      <p className="text-xs text-ms-muted">{USERNAME_RULE_HINT}</p>
      <button type="submit" disabled={pending} className="ms-btn ms-btn-secondary self-start">
        {pending ? "保存中..." : current ? "ユーザー名を変更する" : "ユーザー名を設定する"}
      </button>
      {state.status === "saved" && state.message && (
        <p role="status" data-testid="username-saved" className="text-xs text-ms-text">
          {state.message}
        </p>
      )}
      {state.status === "error" && state.message && <ErrorMessage message={state.message} />}
    </form>
  );
}
