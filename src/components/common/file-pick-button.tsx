"use client";

import { useRef, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/button";

interface FilePickButtonProps {
  /** ボタンに表示する文字 */
  children: ReactNode;
  /** 受け付けるファイルの種類（<input type="file"> の accept と同じ書き方） */
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** 読み込み中など。true の間は押せない */
  loading?: boolean;
  /** ファイル入力の名前（スクリーンリーダーや自動テスト用）。省略するとボタンの文字だけが名前になる */
  inputLabel?: string;
  inputTestId?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  onFilesSelected: (files: File[]) => void;
}

/**
 * 「ファイルを選ぶ」ボタン（小さな追加ファイルの選択用）。
 * ページのメインの入力には FileDropzone を使い、設定欄の中の「ロゴ画像を選ぶ」
 * 「フォントを選ぶ」のような補助的な選択に使う。
 *
 * - 見た目と操作（フォーカス表示・無効・タップ領域）は共通の Button と同じ。
 *   Tab で移動でき、Enter / Space で選択画面が開く。
 * - 同じファイルを続けて選び直しても反応するように、選択のたびに入力欄を空に戻す。
 * - 形式やサイズの検査はここでは行わない（各ツールの既存の検査・エラー文言をそのまま使うため）。
 * - ファイルはブラウザの中で受け取るだけで、ここでサーバーへ送ることはない。
 */
export function FilePickButton({
  children,
  accept,
  multiple = false,
  disabled,
  loading,
  inputLabel,
  inputTestId,
  variant = "secondary",
  size = "md",
  className,
  onFilesSelected,
}: FilePickButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <Button
        variant={variant}
        size={size}
        disabled={disabled}
        loading={loading}
        className={className}
        onClick={() => inputRef.current?.click()}
      >
        {children}
      </Button>
      <input
        ref={inputRef}
        type="file"
        aria-label={inputLabel}
        data-testid={inputTestId}
        accept={accept}
        multiple={multiple}
        disabled={disabled || loading}
        className="hidden"
        tabIndex={-1}
        onChange={(e) => {
          // 入力欄を空に戻す前に、選ばれたファイルを取り出しておく
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) onFilesSelected(files);
        }}
      />
    </>
  );
}
