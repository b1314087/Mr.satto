"use client";

import { useCallback, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils/cn";

interface FileDropzoneProps {
  accept?: string;
  multiple?: boolean;
  maxSizeMB?: number;
  label?: string;
  hint?: string;
  onFilesSelected: (files: File[]) => void;
  onError?: (message: string) => void;
}

/**
 * `accept` に指定されたパターン（MIMEタイプ／"image/*"／".csv" のような拡張子）
 * のいずれかにファイルが一致するかを判定する。
 * ファイル選択ダイアログの `accept` 属性はドラッグ&ドロップには効かないため、
 * ドロップ時にも同じ判定を通すために使う。
 */
function matchesAccept(file: File, accept: string): boolean {
  const patterns = accept
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;

  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();

  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) {
      return name.endsWith(pattern);
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, pattern.indexOf("/"));
      return type.startsWith(`${prefix}/`);
    }
    return type === pattern;
  });
}

/**
 * 共通ファイル選択UI。ドラッグ&ドロップとタップ操作の両方に対応し、
 * スマートフォンでも扱いやすいサイズにする（21章）。
 * 各ツールが独自のアップロードUIを作らないための共通コンポーネント（16章）。
 *
 * ファイル選択・ドラッグ&ドロップのどちらの経路でも `validateAndEmit` を
 * 通すことで、形式チェック・サイズチェックを共通化している。
 * ここでの形式チェックは「明らかに対象外のファイルを早期に弾く」ためのもので、
 * 各Processor側のエラー処理を代替するものではない。
 */
export function FileDropzone({
  accept,
  multiple = false,
  maxSizeMB = 50,
  label = "ファイルをドラッグ&ドロップ",
  hint = "またはタップして選択",
  onFilesSelected,
  onError,
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const validateAndEmit = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);

      if (accept) {
        // ファイル選択ダイアログのaccept属性はドラッグ&ドロップには効かないため、
        // ここで両方の経路に共通のチェックをかける
        const unsupported = files.find((f) => !matchesAccept(f, accept));
        if (unsupported) {
          onError?.(
            `このファイル形式には対応していません（${unsupported.name}）。対応している形式のファイルを選択してください。`
          );
          return;
        }
      }

      const maxBytes = maxSizeMB * 1024 * 1024;
      const tooLarge = files.find((f) => f.size > maxBytes);
      if (tooLarge) {
        onError?.(
          `ファイルサイズが大きすぎます（上限 ${maxSizeMB}MB）。ファイルを確認してください。`
        );
        return;
      }
      onFilesSelected(multiple ? files : [files[0]]);
    },
    [accept, maxSizeMB, multiple, onFilesSelected, onError]
  );

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        validateAndEmit(e.dataTransfer.files);
      }}
      className={cn(
        "flex min-h-40 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition-colors",
        isDragging
          ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
          : "border-neutral-300 bg-neutral-50 hover:border-blue-400 hover:bg-blue-50/50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-blue-500 dark:hover:bg-blue-950/20"
      )}
    >
      <svg
        className="h-8 w-8 text-neutral-400"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 8.25 12 3.75m0 0L7.5 8.25M12 3.75v13.5"
        />
      </svg>
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">{label}</p>
      <p className="text-xs text-neutral-500 dark:text-neutral-400">{hint}</p>
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => validateAndEmit(e.target.files)}
      />
    </div>
  );
}
