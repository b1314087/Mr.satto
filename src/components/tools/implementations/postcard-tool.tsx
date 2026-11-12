"use client";

import { useEffect, useRef, useState } from "react";
import { ErrorMessage } from "@/components/common/error-message";
import { FilePickButton } from "@/components/common/file-pick-button";
import { ProcessingStatus, type ProcessingState } from "@/components/common/processing-status";
import { ResultPopup } from "@/components/common/result-popup";
import { SliderField } from "@/components/common/slider-field";
import { TextColorField } from "@/components/common/text-color-field";
import { RewardedDownloadGate } from "@/components/ads/rewarded-download-gate";
import { RunBar } from "@/components/ui/run-bar";
import { Segmented } from "@/components/ui/segmented";
import { StepHeading } from "@/components/ui/step-heading";
import { PostcardProcessor } from "@/lib/processors/browser/postcard";
import {
  POSTCARD_IMAGE_MAX_PCT,
  POSTCARD_IMAGE_MIN_PCT,
  POSTCARD_MAX_IMAGES,
  POSTCARD_MAX_TEXTS,
  POSTCARD_ORIENTATION_LABELS,
  POSTCARD_TEXT_MAX_PT,
  POSTCARD_TEXT_MIN_PT,
  layoutPostcardImage,
  layoutPostcardText,
  postcardSizePt,
  validatePostcard,
  type PostcardOrientation,
  type PostcardText,
} from "@/lib/print/postcard-layout";
import { downloadBlob } from "@/lib/utils/format";

/** 置いた画像（ファイルと、プレビュー用のURL） */
interface PlacedImage {
  id: string;
  file: File;
  url: string;
  naturalWidth: number;
  naturalHeight: number;
  x: number;
  y: number;
  widthPct: number;
}

type Selected = { kind: "text" | "image"; id: string } | null;

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,.png,.jpg,.jpeg,.webp,.gif";
const IMAGE_MAX_MB = 30;

function readImageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("画像を読み込めませんでした"));
    img.src = url;
  });
}

/**
 * ハガキ作成（次期機能追加 1）。
 * はがき（100mm × 148mm）に文字と画像を置き、プレビューで確かめてからPDFにする。
 * - 縦向き・横向きを選べる。
 * - 文字：内容・大きさ・色・位置（X・Y）を決められる（複数置ける）。
 * - 画像：位置（X・Y）と大きさを決められる。縦横比は保つ（引き伸ばし・切り抜きはしない）。
 * - プレビューとPDFは、同じ配置の計算（src/lib/print/postcard-layout.ts）を使う。
 * 宛名面の郵便番号の枠・住所録などは扱わない（文字と画像を自由に置く面を作る）。
 */
export function PostcardTool() {
  const [orientation, setOrientation] = useState<PostcardOrientation>("portrait");
  const [texts, setTexts] = useState<PostcardText[]>([{ id: "t1", text: "", size: 24, color: "#111111", x: 50, y: 50 }]);
  const [images, setImages] = useState<PlacedImage[]>([]);
  const [selected, setSelected] = useState<Selected>({ kind: "text", id: "t1" });
  const [status, setStatus] = useState<ProcessingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);
  const nextId = useRef(2);
  const imagesRef = useRef<PlacedImage[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  // 画面を離れるときに、プレビュー用のURLを手放す
  useEffect(() => () => imagesRef.current.forEach((img) => URL.revokeObjectURL(img.url)), []);

  const page = postcardSizePt(orientation);
  const changed = () => {
    setResult(null);
    setStatus("idle");
    setError(null);
  };

  function updateText(id: string, patch: Partial<PostcardText>) {
    setTexts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    changed();
  }
  function updateImage(id: string, patch: Partial<PlacedImage>) {
    setImages((prev) => prev.map((img) => (img.id === id ? { ...img, ...patch } : img)));
    changed();
  }
  function addText() {
    if (texts.length >= POSTCARD_MAX_TEXTS) return;
    const id = `t${nextId.current++}`;
    setTexts((prev) => [...prev, { id, text: "", size: 18, color: "#111111", x: 50, y: 50 }]);
    setSelected({ kind: "text", id });
    changed();
  }
  function removeText(id: string) {
    setTexts((prev) => prev.filter((t) => t.id !== id));
    setSelected(null);
    changed();
  }
  async function addImages(files: File[]) {
    const room = POSTCARD_MAX_IMAGES - images.length;
    if (room <= 0) {
      setError(`画像は${POSTCARD_MAX_IMAGES}枚まで置けます。`);
      return;
    }
    const added: PlacedImage[] = [];
    for (const file of files.slice(0, room)) {
      const url = URL.createObjectURL(file);
      try {
        const size = await readImageSize(url);
        added.push({ id: `i${nextId.current++}`, file, url, naturalWidth: size.width, naturalHeight: size.height, x: 50, y: 50, widthPct: 60 });
      } catch {
        URL.revokeObjectURL(url);
        setError(`${file.name} を画像として読み込めませんでした。JPG・PNG・WebPなどの画像を選んでください。`);
      }
    }
    if (added.length === 0) return;
    setImages((prev) => [...prev, ...added]);
    setSelected({ kind: "image", id: added[added.length - 1].id });
    changed();
  }
  function removeImage(id: string) {
    setImages((prev) => {
      const target = prev.find((img) => img.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((img) => img.id !== id);
    });
    setSelected(null);
    changed();
  }

  async function handleRun() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const out = await new PostcardProcessor().process({ orientation, texts, images });
      setResult(out.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFを作成できませんでした");
      setStatus("error");
    }
  }

  const problem = validatePostcard(texts, images);
  const selText = selected?.kind === "text" ? texts.find((t) => t.id === selected.id) : undefined;
  const selImage = selected?.kind === "image" ? images.find((img) => img.id === selected.id) : undefined;

  const preview = (
    <div className="flex flex-col gap-2" data-testid="tool-preview">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
        プレビュー（はがき 100×148mm・{POSTCARD_ORIENTATION_LABELS[orientation]}）
      </p>
      <svg
        viewBox={`0 0 ${page.width} ${page.height}`}
        role="img"
        aria-label="はがきの印刷イメージ"
        data-testid="postcard-preview"
        data-orientation={orientation}
        className="mx-auto block max-h-[42vh] w-auto max-w-full overflow-hidden border border-neutral-400 bg-white shadow-sm lg:max-h-[calc(100vh-12rem)]"
        style={{ fontFamily: "'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif", aspectRatio: `${page.width} / ${page.height}` }}
      >
        <rect x={0} y={0} width={page.width} height={page.height} fill="#ffffff" />
        {images.map((img) => {
          const box = layoutPostcardImage(img, page);
          const isSel = selected?.kind === "image" && selected.id === img.id;
          return (
            <g key={img.id} onClick={() => setSelected({ kind: "image", id: img.id })} style={{ cursor: "pointer" }} data-testid="postcard-preview-image">
              <image href={img.url} x={box.x} y={box.y} width={box.width} height={box.height} preserveAspectRatio="none" />
              {isSel && <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="none" stroke="#2563eb" strokeWidth={1.2} strokeDasharray="4 3" />}
            </g>
          );
        })}
        {texts.map((t) =>
          t.text.trim() === "" ? null : (
            <g key={t.id} onClick={() => setSelected({ kind: "text", id: t.id })} style={{ cursor: "pointer" }}>
              {layoutPostcardText(t, page).map((line, i) => (
                <text key={i} x={line.x} y={line.baseline} fontSize={t.size} fill={t.color} textAnchor="middle" data-testid="postcard-preview-text">
                  {line.text}
                </text>
              ))}
            </g>
          )
        )}
      </svg>
      <p className="text-xs text-ms-muted">文字や画像を押すと、その設定を変えられます。</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,460px)] lg:items-start">
        {/* スマホではプレビューを先に（上に）出し、設定を変えながら見られるようにする */}
        <div className="order-first min-w-0 lg:order-none lg:sticky lg:top-20 lg:col-start-2 lg:row-start-1">{preview}</div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-1">
          <section className="flex flex-col gap-3">
            <StepHeading n={1} as="h2">
              はがきの向き
            </StepHeading>
            <Segmented
              ariaLabel="はがきの向き"
              testId="postcard-orientation"
              value={orientation}
              onChange={(v) => {
                setOrientation(v);
                changed();
              }}
              options={[
                { value: "portrait", label: "縦向き" },
                { value: "landscape", label: "横向き" },
              ]}
            />
          </section>

          <section className="flex flex-col gap-3">
            <StepHeading n={2} as="h2">
              文字と画像を置く
            </StepHeading>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={addText}
                disabled={texts.length >= POSTCARD_MAX_TEXTS}
                data-testid="postcard-add-text"
                className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-neutral-200"
              >
                ＋ 文字を追加
              </button>
              <FilePickButton
                accept={IMAGE_ACCEPT}
                multiple
                size="sm"
                inputLabel="はがきに置く画像"
                inputTestId="postcard-image-input"
                onFilesSelected={(files) => {
                  const tooBig = files.filter((f) => f.size > IMAGE_MAX_MB * 1024 * 1024);
                  if (tooBig.length > 0) setError(`${tooBig.map((f) => f.name).join("、")} は大きすぎます（1枚${IMAGE_MAX_MB}MBまで）。`);
                  void addImages(files.filter((f) => f.size <= IMAGE_MAX_MB * 1024 * 1024));
                }}
              >
                ＋ 画像を追加
              </FilePickButton>
            </div>

            {(texts.length > 0 || images.length > 0) && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="設定を変える文字・画像" data-testid="postcard-items">
                {texts.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={selected?.kind === "text" && selected.id === t.id}
                    onClick={() => setSelected({ kind: "text", id: t.id })}
                    className="max-w-[12rem] truncate rounded-full border border-neutral-300 px-3 py-1 text-xs aria-pressed:border-blue-500 aria-pressed:bg-blue-50 aria-pressed:text-blue-700 dark:border-neutral-700 dark:aria-pressed:bg-blue-950/40 dark:aria-pressed:text-blue-200"
                  >
                    文字{i + 1}
                    {t.text.trim() ? `：${t.text.trim().split("\n")[0]}` : "（未入力）"}
                  </button>
                ))}
                {images.map((img, i) => (
                  <button
                    key={img.id}
                    type="button"
                    aria-pressed={selected?.kind === "image" && selected.id === img.id}
                    onClick={() => setSelected({ kind: "image", id: img.id })}
                    className="max-w-[12rem] truncate rounded-full border border-neutral-300 px-3 py-1 text-xs aria-pressed:border-blue-500 aria-pressed:bg-blue-50 aria-pressed:text-blue-700 dark:border-neutral-700 dark:aria-pressed:bg-blue-950/40 dark:aria-pressed:text-blue-200"
                  >
                    画像{i + 1}：{img.file.name}
                  </button>
                ))}
              </div>
            )}

            {selText && (
              <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="postcard-text-settings">
                <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  文字（改行できます）
                  <textarea
                    value={selText.text}
                    onChange={(e) => updateText(selText.id, { text: e.target.value })}
                    rows={3}
                    placeholder="例: あけましておめでとうございます"
                    data-testid="postcard-text-input"
                    className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
                  />
                </label>
                <SliderField
                  label="文字の大きさ"
                  value={selText.size}
                  min={POSTCARD_TEXT_MIN_PT}
                  max={POSTCARD_TEXT_MAX_PT}
                  unit="pt"
                  onChange={(v) => updateText(selText.id, { size: v })}
                />
                <TextColorField value={selText.color} onChange={(c) => updateText(selText.id, { color: c })} testId="postcard-text-color" />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
                  <SliderField label="横の位置（X）" value={selText.x} min={0} max={100} unit="%" onChange={(v) => updateText(selText.id, { x: v })} />
                  <SliderField label="縦の位置（Y）" value={selText.y} min={0} max={100} unit="%" onChange={(v) => updateText(selText.id, { y: v })} />
                </div>
                <p className="text-xs text-ms-muted">位置は文字のまとまりの中心です（0%＝左端・上端、100%＝右端・下端）。</p>
                <button
                  type="button"
                  onClick={() => removeText(selText.id)}
                  className="w-fit rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  この文字を削除
                </button>
              </div>
            )}

            {selImage && (
              <div className="flex flex-col gap-4 rounded-xl border border-neutral-200 p-4 dark:border-neutral-800" data-testid="postcard-image-settings">
                <p className="text-xs text-ms-muted">
                  {selImage.file.name}（{selImage.naturalWidth}×{selImage.naturalHeight}px）。大きさは、はがきの幅に対する割合です。縦横比はそのままで、大きさだけを変えます。
                </p>
                <SliderField
                  label="画像の大きさ"
                  ariaLabel="画像の大きさ（はがきの幅に対する割合）"
                  value={selImage.widthPct}
                  min={POSTCARD_IMAGE_MIN_PCT}
                  max={POSTCARD_IMAGE_MAX_PCT}
                  unit="%"
                  onChange={(v) => updateImage(selImage.id, { widthPct: v })}
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1">
                  <SliderField label="横の位置（X）" value={selImage.x} min={0} max={100} unit="%" onChange={(v) => updateImage(selImage.id, { x: v })} />
                  <SliderField label="縦の位置（Y）" value={selImage.y} min={0} max={100} unit="%" onChange={(v) => updateImage(selImage.id, { y: v })} />
                </div>
                <p className="text-xs text-ms-muted">位置は画像の中心です。はがきからはみ出した部分は印刷されません。</p>
                <button
                  type="button"
                  onClick={() => removeImage(selImage.id)}
                  className="w-fit rounded-lg px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                >
                  この画像を削除
                </button>
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <StepHeading n={3} as="h2">
              PDFにして印刷する
            </StepHeading>
            <p className="text-xs text-ms-muted">
              はがきの大きさのPDFを作ります。印刷するときは、用紙を「はがき」、倍率を「実際のサイズ（100%）」にしてください（「用紙に合わせる」にすると、配置がずれることがあります）。
            </p>
          </section>
        </div>
      </div>

      <RunBar>
        <button
          type="button"
          onClick={handleRun}
          disabled={!!problem || status === "processing"}
          aria-busy={status === "processing" || undefined}
          data-testid="postcard-run"
          className="w-fit rounded-lg bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
        >
          PDFを作成する
        </button>
      </RunBar>

      <ProcessingStatus state={status} successLabel="PDFを作成しました" />
      {error && <ErrorMessage message={error} />}
      {result && (
        <ResultPopup>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">はがき（100×148mm・{POSTCARD_ORIENTATION_LABELS[orientation]}）1枚のPDFです。</p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result, "はがき.pdf")} label="PDFをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
