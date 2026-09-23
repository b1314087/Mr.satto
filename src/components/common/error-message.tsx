/**
 * エラー表示用の共通コンポーネント。
 * 技術的なエラー内容をそのまま出さず、ユーザーに分かる文言で表示する（28章）。
 * Processor層は日本語の分かりやすいメッセージを throw する設計にしているため、
 * ここではそのメッセージを表示しつつ、想定外のエラーには汎用文言を使う。
 */
export function ErrorMessage({ message }: { message: string }) {
  const displayMessage =
    message && message.length < 200
      ? message
      : "処理に失敗しました。ファイル形式またはファイルサイズを確認してください。";

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300"
    >
      <svg
        className="mt-0.5 h-4 w-4 shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
        />
      </svg>
      <span>{displayMessage}</span>
    </div>
  );
}
