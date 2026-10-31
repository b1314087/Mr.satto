"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { matchesAccept } from "@/lib/utils/file-accept";
import { useHandoffReceiver } from "@/components/handoff/handoff-provider";

interface FileDropzoneProps {
  accept?: string;
  multiple?: boolean;
  maxSizeMB?: number;
  label?: string;
  hint?: string;
  onFilesSelected: (files: File[]) => void;
  onError?: (message: string) => void;
  /**
   * ほかのツールから受け渡されたファイル（工程16）を、この欄で受け取るか。既定は受け取る。
   * 受け取るのは、ページで最初に表示された1つの欄だけ。補助的な欄（ロゴ画像など）は false にする。
   */
  acceptHandoff?: boolean;
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
 *
 * ほかのツールから受け渡されたファイル（工程16、src/components/handoff/handoff-provider.tsx）も、
 * 利用者が選んだときと同じ確認（形式・サイズ・数）を通してから onFilesSelected に渡す。
 */
export function FileDropzone({
  accept,
  multiple = false,
  maxSizeMB = 50,
  label = "ファイルをドラッグ&ドロップ",
  hint = "またはタップして選択",
  onFilesSelected,
  onError,
  acceptHandoff = true,
}: FileDropzoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  // 形式・サイズの確認。問題があれば利用者向けのメッセージを返す（選択・ドロップ・受け渡しで共通）
  const findProblem = useCallback(
    (files: File[]): string | null => {
      if (accept) {
        // ファイル選択ダイアログのaccept属性はドラッグ&ドロップには効かないため、
        // ここで両方の経路に共通のチェックをかける
        const unsupported = files.find((f) => !matchesAccept(f, accept));
        if (unsupported) {
          return `このファイル形式には対応していません（${unsupported.name}）。対応している形式のファイルを選択してください。`;
        }
      }

      const maxBytes = maxSizeMB * 1024 * 1024;
      const tooLarge = files.find((f) => f.size > maxBytes);
      if (tooLarge) {
        return `ファイルサイズが大きすぎます（上限 ${maxSizeMB}MB）。ファイルを確認してください。`;
      }
      return null;
    },
    [accept, maxSizeMB]
  );

  const validateAndEmit = useCallback(
    (fileList: ArrayLike<File> | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      const problem = findProblem(files);
      if (problem) {
        onError?.(problem);
        return;
      }
      onFilesSelected(multiple ? files : [files[0]]);
    },
    [findProblem, multiple, onFilesSelected, onError]
  );

  // ほかのツールから受け渡されたファイルがあれば、最初に表示された欄で1回だけ受け取る（工程16）
  const handoff = useHandoffReceiver();
  const hasPendingHandoff = acceptHandoff && handoff !== null && handoff.hasPending;
  useEffect(() => {
    if (!hasPendingHandoff || !handoff) return;
    handoff.claim((files) => {
      if (!multiple && files.length > 1) return "このツールは、ファイルを1つずつしか受け取れません。";
      const problem = findProblem(files);
      if (problem) return problem;
      onFilesSelected(files);
      return null;
    });
    // 受け取りは1回だけ（claim側でも二重に受け取らないよう守っている）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasPendingHandoff]);

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
        onChange={(e) => {
          // 入力欄を空に戻す前に、選ばれたファイルを取り出しておく（FilePickButton と同じ方式）。
          // 空に戻さないと、直前と同じファイルを選び直したとき、ブラウザが変更を通知せず（change が発生せず）、
          // 確認で取り消したあとの選び直しなどができない。取り出した File は入力欄とは独立しているので、空に戻しても失われない。
          // 取り消し（何も選ばない）の場合は files が空なので、何も処理されない。
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          validateAndEmit(files);
        }}
      />
    </div>
  );
}
