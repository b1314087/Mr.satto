"use client";

import { PreviewSplitLayout } from "@/components/common/preview-split-layout";
import { useState } from "react";
import { QrCodeProcessor } from "@/lib/processors/browser/qrcode";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ErrorMessage } from "@/components/common/error-message";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { downloadBlob, dataUrlToBlob } from "@/lib/utils/format";
import { useLiveQr } from "./shared/use-live-qr";

function buildVCard(fields: Record<string, string>): string {
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    fields.name ? `N:${fields.name};;;;` : "",
    fields.name ? `FN:${fields.name}` : "",
    fields.org ? `ORG:${fields.org}` : "",
    fields.title ? `TITLE:${fields.title}` : "",
    fields.tel ? `TEL;TYPE=WORK,VOICE:${fields.tel}` : "",
    fields.email ? `EMAIL:${fields.email}` : "",
    fields.url ? `URL:${fields.url}` : "",
    "END:VCARD",
  ].filter(Boolean);
  return lines.join("\n");
}

export function BusinessCardQrTool() {
  const [name, setName] = useState("");
  const [org, setOrg] = useState("");
  const [title, setTitle] = useState("");
  const [tel, setTel] = useState("");
  const [email, setEmail] = useState("");
  const [url, setUrl] = useState("");

  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);

  // 入力のたびにvCardを組み立て直し、その場で二次元コードを更新する（氏名が空の間は表示しない）
  const vcard = name.trim() ? buildVCard({ name, org, title, tel, email, url }) : "";
  const live = useLiveQr(vcard, { errorCorrectionLevel: "Q" });
  const dataUrl = live.dataUrl;

  async function handleGenerate() {
    setStatus("processing");
    setError(null);
    try {
      // プレビューと同じvCard・同じ設定で生成する
      await new QrCodeProcessor().process({
        text: buildVCard({ name, org, title, tel, email, url }),
        errorCorrectionLevel: "Q",
      });
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成に失敗しました");
      setStatus("error");
    }
  }

  function handleDownload() {
    if (!dataUrl) return;
    // data URLはfetch()を使わずに直接Blobへ変換する（CSPのconnect-srcに
    // data:を含めていないため、fetch(dataUrl)は失敗する。詳細はformat.tsの
    // dataUrlToBlob()のコメントを参照）。
    const blob = dataUrlToBlob(dataUrl);
    downloadBlob(blob, "business-card-qr.png");
  }

  const fields: { label: string; value: string; setter: (v: string) => void; placeholder: string }[] = [
    { label: "氏名", value: name, setter: setName, placeholder: "山田 太郎" },
    { label: "会社名", value: org, setter: setOrg, placeholder: "株式会社サンプル" },
    { label: "役職", value: title, setter: setTitle, placeholder: "営業部長" },
    { label: "電話番号", value: tel, setter: setTel, placeholder: "03-1234-5678" },
    { label: "メールアドレス", value: email, setter: setEmail, placeholder: "taro@example.com" },
    { label: "Webサイト", value: url, setter: setUrl, placeholder: "https://example.com" },
  ];

  return (
    <PreviewSplitLayout
      preview={
      <div
        data-testid="tool-preview"
        className="flex flex-col items-start gap-3 rounded-xl border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-800 dark:bg-neutral-900"
      >
        <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400">プレビュー（入力に合わせて自動で更新されます）</p>
        {dataUrl ? (
          <div className="flex flex-col items-start gap-4 sm:flex-row">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={dataUrl} alt="生成された名刺二次元コード" className="h-48 w-48 rounded-lg bg-white p-2" />
            <div className="flex flex-col gap-1 text-sm">
              <p className="text-xs text-neutral-500 dark:text-neutral-400">読み取ると次の連絡先が登録されます</p>
              {[
                ["氏名", name],
                ["会社名", org],
                ["役職", title],
                ["電話番号", tel],
                ["メール", email],
                ["Web", url],
              ]
                .filter(([, v]) => v.trim())
                .map(([k, v]) => (
                  <p key={k} className="break-all">
                    <span className="mr-2 text-xs text-neutral-500 dark:text-neutral-400">{k}</span>
                    {v}
                  </p>
                ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            氏名を入力すると、ここに名刺二次元コードが表示されます。
          </p>
        )}
        {dataUrl && (
          <RewardedDownloadGate onDownload={handleDownload} label="画像としてダウンロード" disabled={!live.fresh} />
        )}
      </div>
      }
    >
      <p className="text-sm text-neutral-500 dark:text-neutral-400">
        入力した連絡先はブラウザ内で二次元コード化されるだけで、どこにも送信・保存されません。
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((f) => (
          <label key={f.label} className="flex flex-col gap-1.5 text-sm">
            {f.label}
            <input
              value={f.value}
              onChange={(e) => f.setter(e.target.value)}
              placeholder={f.placeholder}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 dark:border-neutral-700 dark:bg-neutral-900"
            />
          </label>
        ))}
      </div>

      <button
        type="button"
        onClick={handleGenerate}
        disabled={!name.trim() || status === "processing"}
        className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
      >
        名刺二次元コードを生成する
      </button>

      <ProcessingStatus state={status} successLabel="生成しました" />
      {error && <ErrorMessage message={error} />}
    </PreviewSplitLayout>
  );
}
