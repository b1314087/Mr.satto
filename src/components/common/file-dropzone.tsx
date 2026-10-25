"use client";

import { useCallback, useId, useRef, useState } from "react";

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

  const hintId = `${inputId}-hint`;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-describedby={hintId}
      data-dragging={isDragging ? "true" : undefined}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        // 入力欄の中のキー操作（hiddenなので通常は起きない）には反応せず、この領域自身にフォーカスがある時だけ開く
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          // スペースでページがスクロールしてしまうのを防ぐ
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        // 中の文字やアイコンの上に移っただけでは、ドラッグ中の表示を解除しない（ちらつき防止）
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        validateAndEmit(e.dataTransfer.files);
      }}
      className="ms-dropzone"
    >
      <svg
        className="h-10 w-10 text-ms-accent dark:text-ms-focus"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M7 18.25h-.5a4.25 4.25 0 0 1-.6-8.46 5.75 5.75 0 0 1 11.1-1.04A4.75 4.75 0 0 1 17 18.25h-.5M12 20.25v-8m0 0-3 3m3-3 3 3"
        />
      </svg>
      <p className="text-sm font-medium text-ms-text">{label}</p>
      <p id={hintId} className="text-xs text-ms-muted">
        {isDragging ? "ここでマウスを離すと選択されます" : hint}
      </p>
      {/* 見た目だけの「ファイルを選択」ボタン（文字は CSS で出す。操作は枠全体のクリック・キー操作が担う） */}
      <span aria-hidden="true" className="ms-dropzone-cta" />
      <input
        id={inputId}
        ref={inputRef}
        type="file"
        aria-label={label}
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => validateAndEmit(e.target.files)}
      />
    </div>
  );
}
