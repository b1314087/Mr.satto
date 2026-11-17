import type { QuestionType } from "@/lib/survey/model";

/** アンケート用紙作成で使う小さなアイコン（文字のボタンを減らし、見て分かるようにする） */

const base = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export function DragIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <circle cx="9" cy={y} r="1.6" />
          <circle cx="15" cy={y} r="1.6" />
        </g>
      ))}
    </svg>
  );
}

export function CopyIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

export function ChevronIcon({ dir, className = "h-4 w-4" }: { dir: "up" | "down"; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d={dir === "up" ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />
    </svg>
  );
}

export function PlusIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function FileIcon({ kind, className = "h-4 w-4" }: { kind: "pdf" | "word" | "print"; className?: string }) {
  if (kind === "print")
    return (
      <svg viewBox="0 0 24 24" className={className} {...base}>
        <path d="M7 9V4h10v5" />
        <rect x="4" y="9" width="16" height="8" rx="2" />
        <path d="M7 14h10v6H7z" />
      </svg>
    );
  return (
    <svg viewBox="0 0 24 24" className={className} {...base}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d={kind === "pdf" ? "M9 13h6M9 17h4" : "M9 13l1.2 4 1.8-4 1.8 4 1.2-4"} />
    </svg>
  );
}

/** 質問の形式のアイコン（用紙での見た目に近い形） */
export function TypeIcon({ type, className = "h-5 w-5" }: { type: QuestionType; className?: string }) {
  switch (type) {
    case "single":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.5" fill="currentColor" />
        </svg>
      );
    case "multiple":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M8 12l3 3 5-6" />
        </svg>
      );
    case "short":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <path d="M4 10h10M4 15h16" />
        </svg>
      );
    case "long":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <path d="M4 6h16M4 10h16M4 14h16M4 18h10" />
        </svg>
      );
    case "rating":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
        </svg>
      );
    case "scale":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <path d="M3 17h18" />
          <circle cx="5" cy="11" r="2" />
          <circle cx="12" cy="11" r="2" />
          <circle cx="19" cy="11" r="2" />
        </svg>
      );
    case "number":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <path d="M9 4L7 20M17 4l-2 16M4 9h16M3 15h16" />
        </svg>
      );
    case "date":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <rect x="4" y="5" width="16" height="15" rx="2" />
          <path d="M8 3v4M16 3v4M4 10h16" />
        </svg>
      );
    case "section":
      return (
        <svg viewBox="0 0 24 24" className={className} {...base}>
          <rect x="3" y="5" width="18" height="5" rx="1.5" />
          <path d="M5 15h14M5 19h9" />
        </svg>
      );
  }
}
