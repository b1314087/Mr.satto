export type ProcessingState = "idle" | "processing" | "success" | "error";

export function ProcessingStatus({
  state,
  processingLabel = "処理中...",
  successLabel = "処理が完了しました",
}: {
  state: ProcessingState;
  processingLabel?: string;
  successLabel?: string;
}) {
  if (state === "idle" || state === "error") return null;

  if (state === "processing") {
    return (
      <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
        <svg className="h-4 w-4 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>
        <span>{processingLabel}</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4.5 12.75l6 6 9-13.5"
        />
      </svg>
      <span>{successLabel}</span>
    </div>
  );
}
