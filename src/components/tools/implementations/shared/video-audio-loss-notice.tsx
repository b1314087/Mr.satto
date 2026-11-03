"use client";

/**
 * 音声を書き出せないときの案内（動画編集 工程1）。
 *
 * 元の動画には音声があるのに、選んだ出力形式ではお使いのブラウザで音声を書き出せない場合、
 * 何も知らせずに無音の動画を作らず、ここで理由を伝える。
 * 利用者が「音声なしで書き出す」を選んだときだけ、映像だけの動画を書き出す。
 */
export function VideoAudioLossNotice({
  message,
  onProceed,
  onDismiss,
}: {
  message: string;
  onProceed: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="alert"
      data-testid="video-audio-loss"
      className="flex flex-col gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
    >
      <div className="flex flex-col gap-1">
        <p className="font-medium">この設定では音声を残せません。まだ書き出していません。</p>
        <p>{message}</p>
        <p>
          音声を残したい場合は、出力形式を変える（MP4・WebM）か、別のブラウザ（最新のChrome・Edge・Safari）でお試しください。
          音声がなくてもよい場合は、下のボタンで映像だけを書き出せます。
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onProceed}
          className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-amber-700"
        >
          音声なしで書き出す
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-lg border border-amber-400 px-4 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:text-amber-200 dark:hover:bg-amber-900/40"
        >
          やめる
        </button>
      </div>
    </div>
  );
}
