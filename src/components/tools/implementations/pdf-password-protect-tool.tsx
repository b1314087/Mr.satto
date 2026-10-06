"use client";

import { useEffect, useRef, useState } from "react";
import { FileDropzone } from "@/components/common/file-dropzone";
import { FileList } from "@/components/common/file-list";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { PdfPasswordProtectProcessor, type PdfProtectOutput } from "@/lib/processors/browser/pdf-protect";
import { getPdfjs, loadPdfDocument, renderPageToCanvas } from "@/lib/pdf/pdfjs-client";
import { downloadBlob, formatBytes, stripExtension } from "@/lib/utils/format";

const inputClass =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/**
 * PDFパスワード保護。AES-256で暗号化する。
 * 保存前に先頭ページのプレビューを表示し、保存後は「パスワードなしでは開けない/ありなら開ける」を
 * 実際に確かめた結果を表示する。すべてブラウザ内で処理され、PDFもパスワードも送信されない。
 */
export function PdfPasswordProtectTool() {
  const [file, setFile] = useState<File | null>(null);
  const [userPassword, setUserPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [allowPrint, setAllowPrint] = useState(true);
  const [allowCopy, setAllowCopy] = useState(true);
  const [allowModify, setAllowModify] = useState(true);

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<(PdfProtectOutput & { name: string }) | null>(null);
  const [pageInfo, setPageInfo] = useState<{ file: File; pages: number } | null>(null);
  const [previewError, setPreviewError] = useState<{ file: File; message: string } | null>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);

  const pages = file && pageInfo?.file === file ? pageInfo.pages : null;
  const previewMessage = file && previewError?.file === file ? previewError.message : null;

  useEffect(() => {
    return () => {
      if (result) URL.revokeObjectURL(result.url);
    };
  }, [result]);

  // 先頭ページのプレビュー(保護前)
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    (async () => {
      try {
        const pdf = await loadPdfDocument(file);
        const page = await pdf.getPage(1);
        const { canvas } = await renderPageToCanvas(page, 1, 520);
        if (cancelled) return;
        const target = previewRef.current;
        if (target) {
          target.width = canvas.width;
          target.height = canvas.height;
          target.getContext("2d")?.drawImage(canvas, 0, 0);
        }
        setPageInfo({ file, pages: pdf.numPages });
      } catch (e) {
        if (!cancelled) setPreviewError({ file, message: e instanceof Error ? e.message : "プレビューを作成できませんでした" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  function handleFiles(files: File[]) {
    setFile(files[0] ?? null);
    setResult(null);
    setStatus("idle");
    setError(null);
  }

  const mismatch = confirmPassword !== "" && confirmPassword !== userPassword;
  const canRun = file !== null && userPassword !== "" && confirmPassword === userPassword && status !== "processing";

  async function handleRun() {
    if (!file || !canRun) return;
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const output = await new PdfPasswordProtectProcessor().process({
        file,
        userPassword,
        ownerPassword: ownerPassword || undefined,
        permissions: { print: allowPrint, copy: allowCopy, modify: allowModify },
      });
      setResult({ ...output, name: `${stripExtension(file.name)}-protected.pdf` });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
      setStatus("error");
    }
  }

  // 保護後に、パスワードを使って開けることを示すプレビューも出す(読み込んだ結果の確認用)
  const protectedPreviewRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!result) return;
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await getPdfjs();
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        const task = pdfjs.getDocument({ data: bytes, password: userPassword });
        const pdf = await task.promise;
        const page = await pdf.getPage(1);
        const { canvas } = await renderPageToCanvas(page, 1, 520);
        if (!cancelled && protectedPreviewRef.current) {
          const t = protectedPreviewRef.current;
          t.width = canvas.width;
          t.height = canvas.height;
          t.getContext("2d")?.drawImage(canvas, 0, 0);
        }
        await task.destroy();
      } catch {
        /* 確認済みのため表示できなくても処理結果には影響しない */
      }
    })();
    return () => {
      cancelled = true;
    };
    // userPasswordは結果作成時の値を使う(結果が変わったときだけ再描画する)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  return (
    <div className="flex flex-col gap-6">
      <FileDropzone
        accept="application/pdf,.pdf"
        maxSizeMB={100}
        label="PDFをドラッグ&ドロップ"
        hint="またはタップして選択。ファイルもパスワードも外部へ送信されず、端末の中だけで処理されます"
        onFilesSelected={handleFiles}
        onError={setError}
      />
      {file && <FileList files={[file]} onRemove={() => handleFiles([])} />}

      {file && (
        <div className="flex flex-col gap-3 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            先頭ページのプレビュー{pages ? `(全${pages}ページ)` : ""}
          </p>
          {previewMessage && <ErrorMessage message={previewMessage} />}
          <canvas
            ref={previewRef}
            data-testid="protect-preview"
            aria-label="PDFの先頭ページ"
            className="max-h-80 w-auto max-w-full self-start rounded-lg border border-neutral-200 bg-white dark:border-neutral-700"
          />
        </div>
      )}

      {file && (
        <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">開くためのパスワード</span>
              <input
                type={showPassword ? "text" : "password"}
                aria-label="開くためのパスワード"
                autoComplete="new-password"
                value={userPassword}
                onChange={(e) => setUserPassword(e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">パスワード(確認用)</span>
              <input
                type={showPassword ? "text" : "password"}
                aria-label="パスワード(確認用)"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className={inputClass}
              />
            </label>
          </div>
          {mismatch && (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              確認用のパスワードが一致しません
            </p>
          )}
          <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
            <input type="checkbox" checked={showPassword} onChange={(e) => setShowPassword(e.target.checked)} />
            パスワードを表示する
          </label>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">開いた人に許可すること</legend>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input type="checkbox" checked={allowPrint} onChange={(e) => setAllowPrint(e.target.checked)} />
              印刷
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input type="checkbox" checked={allowCopy} onChange={(e) => setAllowCopy(e.target.checked)} />
              文字や画像のコピー
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
              <input type="checkbox" checked={allowModify} onChange={(e) => setAllowModify(e.target.checked)} />
              編集(注釈・フォーム入力・ページの変更)
            </label>
          </fieldset>

          {(!allowPrint || !allowCopy || !allowModify) && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-300">権限を変更するためのパスワード(任意)</span>
              <input
                type={showPassword ? "text" : "password"}
                aria-label="権限を変更するためのパスワード"
                autoComplete="new-password"
                value={ownerPassword}
                onChange={(e) => setOwnerPassword(e.target.value)}
                className={inputClass}
              />
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                空欄の場合は自動で作られ、後から制限を解除できなくなります。
              </span>
            </label>
          )}

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            AES-256で暗号化します。パスワードを忘れるとこのツールを含め誰も開けなくなるため、必ず控えてください。
            印刷・コピーなどの制限は、ビューアが守ることで成り立つ設定で、対応していないソフトでは無視されることがあります。
            非常に古いPDFビューア(Acrobat 8以前など)では開けない場合があります。
          </p>
        </div>
      )}

      {file && (
        <button
          type="button"
          onClick={handleRun}
          disabled={!canRun}
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          パスワードを設定する
        </button>
      )}

      <ProcessingStatus state={status} processingLabel="暗号化しています..." successLabel="パスワードを設定しました" />
      {error && <ErrorMessage message={error} />}

      {result && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          <ul className="flex flex-col gap-1 text-sm text-neutral-700 dark:text-neutral-200">
            <li>✔ パスワードなしでは開けないことを確認しました</li>
            <li>✔ 設定したパスワードで開け、{result.pageCount}ページすべてを読めることを確認しました</li>
          </ul>
          <canvas
            ref={protectedPreviewRef}
            data-testid="protected-preview"
            aria-label="パスワードで開いた先頭ページ"
            className="max-h-64 w-auto max-w-full rounded-lg border border-neutral-200 bg-white dark:border-neutral-700"
          />
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {result.name} ・ {formatBytes(result.sizeBytes)}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result.blob, result.name)} />
        </div>
      )}
    </div>
  );
}
