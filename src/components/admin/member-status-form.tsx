import { changeMemberStatusAction } from "@/app/admin/members/actions";
import { jstDateAfterDays } from "@/lib/plans/grants";

/**
 * 会員1人分の「ステータス変更」フォーム（会員一覧・会員の詳細ページの両方で使う）。
 * ステータス（プレミアム／無料）と、プレミアムの最終日（日本時間）を指定する。メモは詳細ページだけで入力できる。
 */
export function MemberStatusForm({
  userId,
  grantEndsAt,
  active,
  returnTo,
  withNote = false,
}: {
  userId: string;
  /** いま有効な付与の終了時刻（ISO）。最終日の初期値に使う */
  grantEndsAt: string | null;
  active: boolean;
  returnTo: "list" | "detail";
  withNote?: boolean;
}) {
  return (
    <form action={changeMemberStatusAction} className="flex flex-wrap items-center gap-2" data-testid="member-status-form">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="returnTo" value={returnTo} />
      <select
        name="status"
        defaultValue={active ? "premium" : "free"}
        aria-label="変更後のステータス"
        className="rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
      >
        <option value="premium">プレミアム（無料付与）</option>
        <option value="free">無料プラン</option>
      </select>
      <label className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
        最終日
        <input
          type="date"
          name="until"
          defaultValue={grantEndsAt && active ? grantEndsAt.slice(0, 10) : jstDateAfterDays(30)}
          min={jstDateAfterDays(1)}
          aria-label="プレミアムの最終日（その日の終わりまで）"
          className="rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
        />
      </label>
      {withNote && (
        <input
          type="text"
          name="note"
          maxLength={200}
          placeholder="メモ（任意）"
          aria-label="メモ（任意）"
          className="w-48 rounded-lg border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-950"
        />
      )}
      <button
        type="submit"
        className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-700"
      >
        変更する
      </button>
    </form>
  );
}
