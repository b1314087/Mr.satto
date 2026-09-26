"use client";

import { useState } from "react";
import { QrCodeProcessor } from "@/lib/processors/browser/qrcode";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob, dataUrlToBlob } from "@/lib/utils/format";

export function QrGeneratorTool() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  async function handleGenerate() {
    setStatus("processing");
    setError(null);
    try {
      const { dataUrl } = await new QrCodeProcessor().process({ text });
      setDataUrl(dataUrl);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成に失敗しました");
      setStatus("error");
      setDataUrl(null);
    }
  }

  function handleDownload() {
    if (!dataUrl) return;
    // data URLはfetch()を使わずに直接Blobへ変換する（CSPのconnect-srcに
    // data:を含めていないため、fetch(dataUrl)は失敗する。詳細はformat.tsの
    // dataUrlToBlob()のコメントを参照）。
    const blob = dataUrlToBlob(dataUrl);
    downloadBlob(blob, "qrcode.png");
  }

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-1.5 text-sm">
        URLやテキストを入力
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="https://example.com"
          className="rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={!text.trim() || status === "processing"}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        QRコードを生成する
      </button>

      <ProcessingStatus state={status} successLabel="生成しました" />
      {error && <ErrorMessage message={error} />}

      {dataUrl && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={dataUrl} alt="生成されたQRコード" className="h-48 w-48 rounded-lg bg-white p-2" />
          <RewardedDownloadGate onDownload={handleDownload} label="画像としてダウンロード" />
        </div>
      )}
    </div>
  );
}
