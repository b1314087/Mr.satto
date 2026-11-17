"use client";

/**
 * オン・オフを切り替えるスイッチ（2026-11-17）。
 * チェックボックスより「設定を切り替える」ことが分かりやすい場面で使う（例：必須・横に並べる）。
 * 中身は role="switch" のボタン（キーボードの Space・Enter でも切り替わる）。
 */
export function Switch({
  checked,
  onChange,
  label,
  testId,
  size = "md",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  testId?: string;
  size?: "sm" | "md";
}) {
  const track = size === "sm" ? "h-5 w-9" : "h-6 w-11";
  const knob = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  const move = size === "sm" ? "translate-x-4" : "translate-x-5";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="ms-focus-ring inline-flex items-center gap-2 rounded-full text-sm text-neutral-700 dark:text-neutral-200"
      data-testid={testId}
    >
      <span className={`relative inline-flex ${track} shrink-0 items-center rounded-full transition-colors ${checked ? "bg-blue-600" : "bg-neutral-300 dark:bg-neutral-600"}`}>
        <span className={`inline-block ${knob} translate-x-0.5 rounded-full bg-white shadow transition-transform ${checked ? move : ""}`} />
      </span>
      <span>{label}</span>
    </button>
  );
}
