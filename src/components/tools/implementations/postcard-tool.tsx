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
import { SettingsSection, SettingsStack } from "@/components/ui/settings-section";
import { PositionSliders } from "@/components/common/position-sliders";
import { PostcardAddressProcessor, PostcardProcessor } from "@/lib/processors/browser/postcard";
import {
  DEFAULT_POSTCARD_ADDRESS_BLOCKS,
  POSTCARD_ADDRESS_BLOCK_IDS,
  POSTCARD_ADDRESS_BLOCK_LABELS,
  POSTCARD_ADDRESS_MAX_PT,
  POSTCARD_ADDRESS_MIN_PT,
  POSTCARD_OFFSET_MAX_MM,
  defaultPostcardAddress,
  layoutPostcardAddress,
  postcardAddressSizePt,
  recipientZipBoxesPt,
  validatePostcardAddress,
  type PostcardAddressBlockId,
  type PostcardAddressInput,
} from "@/lib/print/postcard-address-layout";
import { HONORIFIC_LABELS, type EnvelopeHonorific } from "@/lib/print/envelope-layout";
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
type PostcardSide = "back" | "address";

const fieldClass =
  "rounded-lg border border-neutral-300 px-3 py-2 text-sm font-normal text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100";

/** 宛名面のプレビュー（PDFと同じ配置の計算を使う） */
function PostcardAddressPreview({ address }: { address: PostcardAddressInput }) {
  const page = postcardAddressSizePt();
  const ops = layoutPostcardAddress(address);
  const guide = recipientZipBoxesPt();
  return (
    <div className="flex flex-col gap-2" data-testid="tool-preview">
      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-200">プレビュー（はがき 100×148mm・宛名面）</p>
      <svg
        viewBox={`0 0 ${page.width} ${page.height}`}
        role="img"
        aria-label="はがきの宛名面の印刷イメージ"
        data-testid="postcard-address-preview"
        className="mx-auto block max-h-[42vh] w-auto max-w-full overflow-hidden border border-neutral-400 bg-white shadow-sm lg:max-h-[calc(100vh-12rem)]"
        style={{ fontFamily: "'Hiragino Sans','Noto Sans JP','Yu Gothic',sans-serif", aspectRatio: `${page.width} / ${page.height}` }}
      >
        <rect x={0} y={0} width={page.width} height={page.height} fill="#ffffff" />
        {/* 郵便番号枠の位置の目安（印刷しない。枠を印刷するときは下の朱色の線） */}
        {!address.printZipFrames &&
          guide.map((b, i) => (
            <rect key={i} x={b.x} y={b.y} width={b.width} height={b.height} fill="none" stroke="#f3a99c" strokeWidth={0.6} strokeDasharray="2 1.5" data-testid="postcard-zip-guide" />
          ))}
        {ops.map((op, i) =>
          op.kind === "rect" ? (
            <rect key={i} x={op.x - op.lineWidth / 2} y={op.y - op.lineWidth / 2} width={op.width + op.lineWidth} height={op.height + op.lineWidth} fill="none" stroke="#e6402a" strokeWidth={op.lineWidth} data-testid="postcard-zip-frame" />
          ) : op.kind === "line" ? (
            <line key={i} x1={op.x1} y1={op.y1} x2={op.x2} y2={op.y2} stroke="#e6402a" strokeWidth={op.lineWidth} />
          ) : (
            <text key={i} x={op.x} y={op.y} fontSize={op.size} textAnchor="middle" fill="#111111" data-testid={`postcard-address-text-${op.role}`}>
              {op.text}
            </text>
          )
        )}
      </svg>
      <p className="text-xs text-ms-muted">点線の枠は、郵便番号枠の位置の目安です（印刷されません）。</p>
    </div>
  );
}

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
 * 総合改修 28：宛名面（郵便番号枠・宛先住所・宛先氏名・差出人。縦書き）も作れる。配置は src/lib/print/postcard-address-layout.ts。
 */
export function PostcardTool() {
  const [side, setSide] = useState<PostcardSide>("back");
  const [address, setAddress] = useState<PostcardAddressInput>(defaultPostcardAddress);
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

  function updateAddress(patch: Partial<PostcardAddressInput>) {
    setAddress((prev) => ({ ...prev, ...patch }));
    changed();
  }
  function updateAddressBlock(id: PostcardAddressBlockId, patch: Partial<PostcardAddressInput["blocks"][PostcardAddressBlockId]>) {
    setAddress((prev) => ({ ...prev, blocks: { ...prev.blocks, [id]: { ...prev.blocks[id], ...patch } } }));
    changed();
  }

  async function handleRun() {
    setStatus("processing");
    setError(null);
    setResult(null);
    try {
      const out = side === "address" ? await new PostcardAddressProcessor().process(address) : await new PostcardProcessor().process({ orientation, texts, images });
      setResult(out.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFを作成できませんでした");
      setStatus("error");
    }
  }

  const problem = side === "address" ? validatePostcardAddress(address) : validatePostcard(texts, images);
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

  const addressSettings = (
    <SettingsStack testId="postcard-address-settings">
      <SettingsSection n={1} title="宛先" testId="postcard-recipient-section" summary={address.recipientName.trim() || "未入力"}>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            郵便番号（7けた）
            <input
              value={address.recipientZip}
              onChange={(e) => updateAddress({ recipientZip: e.target.value })}
              inputMode="numeric"
              autoComplete="off"
              maxLength={10}
              placeholder="例：100-0001"
              data-testid="postcard-recipient-zip"
              className={`${fieldClass} w-40`}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            住所（改行すると、次の列に移ります。建物名などを分けたいときに）
            <textarea
              value={address.recipientAddress}
              onChange={(e) => updateAddress({ recipientAddress: e.target.value })}
              rows={3}
              placeholder={"例：東京都千代田区千代田1-1\n○○マンション101"}
              data-testid="postcard-recipient-address"
              className={fieldClass}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            氏名（連名は改行して入れます）
            <textarea
              value={address.recipientName}
              onChange={(e) => updateAddress({ recipientName: e.target.value })}
              rows={2}
              placeholder="例：山田 太郎"
              data-testid="postcard-recipient-name"
              className={fieldClass}
            />
          </label>
          <Segmented
            ariaLabel="敬称"
            testId="postcard-honorific"
            value={address.honorific}
            onChange={(v: EnvelopeHonorific) => updateAddress({ honorific: v })}
            options={(["sama", "onchu", "none"] as const).map((h) => ({ value: h, label: HONORIFIC_LABELS[h] }))}
          />
          <p className="text-xs text-ms-muted">数字は縦書きに合わせて全角にし、番地の「-」は縦の線（｜）にします。</p>
        </div>
      </SettingsSection>

      <SettingsSection n={2} title="差出人" testId="postcard-sender-section" summary={address.useSender ? address.senderName.trim() || "印刷する" : "印刷しない"}>
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={address.useSender} onChange={(e) => updateAddress({ useSender: e.target.checked })} data-testid="postcard-use-sender" />
            差出人を印刷する
          </label>
          {address.useSender && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                差出人の郵便番号（7けた・任意）
                <input
                  value={address.senderZip}
                  onChange={(e) => updateAddress({ senderZip: e.target.value })}
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="例：530-0001"
                  data-testid="postcard-sender-zip"
                  className={`${fieldClass} w-40`}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                差出人の住所
                <textarea value={address.senderAddress} onChange={(e) => updateAddress({ senderAddress: e.target.value })} rows={2} data-testid="postcard-sender-address" className={fieldClass} />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
                差出人の氏名
                <input value={address.senderName} onChange={(e) => updateAddress({ senderName: e.target.value })} data-testid="postcard-sender-name" className={fieldClass} />
              </label>
              <p className="text-xs text-ms-muted">差出人は左下に縦書きで入れ、郵便番号はその下に横書きで入れます。</p>
            </>
          )}
        </div>
      </SettingsSection>

      <SettingsSection n={3} title="郵便番号枠" testId="postcard-zip-section" summary={address.printZipFrames ? "枠も印刷する" : "数字だけ印刷する"}>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={address.printZipFrames} onChange={(e) => updateAddress({ printZipFrames: e.target.checked })} data-testid="postcard-print-frames" />
            郵便番号枠の線も印刷する（枠が印刷されていない用紙のとき）
          </label>
          <p className="text-xs text-ms-muted">
            郵便番号は、日本郵便の定める枠の位置（はがきの上端から12mm・右端から8mm、1けた5.7×8mm）に1けたずつ入れます。郵便はがき（官製はがき）など、枠が印刷済みのはがきでは、線は印刷しないでください。
          </p>
        </div>
      </SettingsSection>

      <SettingsSection n={4} title="文字の大きさ・位置" testId="postcard-layout-section">
        <div className="flex flex-col gap-3">
          {POSTCARD_ADDRESS_BLOCK_IDS.filter((id) => id !== "sender" || address.useSender).map((id) => {
            const b = address.blocks[id];
            const label = POSTCARD_ADDRESS_BLOCK_LABELS[id];
            return (
              <details key={id} open={id === "name"} className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800" data-testid={`postcard-block-${id}`}>
                <summary className="cursor-pointer text-sm font-medium">{label}</summary>
                <div className="mt-3 flex flex-col gap-3">
                  <SliderField
                    label="文字の大きさ"
                    ariaLabel={`${label}の文字の大きさ`}
                    value={b.size}
                    min={POSTCARD_ADDRESS_MIN_PT}
                    max={POSTCARD_ADDRESS_MAX_PT}
                    step={0.5}
                    unit="pt"
                    onChange={(v) => updateAddressBlock(id, { size: v })}
                  />
                  <PositionSliders
                    x={b.x}
                    y={b.y}
                    step={0.5}
                    xAriaLabel={`${label}の横の位置`}
                    yAriaLabel={`${label}の縦の位置`}
                    onChange={({ x, y }) => updateAddressBlock(id, { x, y })}
                    hint="横はいちばん右の列の中心、縦は文字の上端の位置です（0%＝左端・上端）。"
                  />
                  <button
                    type="button"
                    onClick={() => updateAddressBlock(id, { ...DEFAULT_POSTCARD_ADDRESS_BLOCKS[id] })}
                    className="w-fit rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                  >
                    {label}を標準に戻す
                  </button>
                </div>
              </details>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection n={5} title="印刷位置の微調整" testId="postcard-offset-section" summary={address.offsetXmm === 0 && address.offsetYmm === 0 ? "調整なし" : `横${address.offsetXmm}mm・縦${address.offsetYmm}mm`}>
        <div className="flex flex-col gap-3">
          <PositionSliders
            x={address.offsetXmm}
            y={address.offsetYmm}
            min={-POSTCARD_OFFSET_MAX_MM}
            max={POSTCARD_OFFSET_MAX_MM}
            step={0.1}
            unit="mm"
            xLabel="横のずれ（右が＋）"
            yLabel="縦のずれ（下が＋）"
            onChange={({ x, y }) => updateAddress({ offsetXmm: x, offsetYmm: y })}
            testId="postcard-offset"
          />
          <p className="text-xs text-ms-muted">
            試しに普通紙へ印刷して、はがきと重ねて確かめ、ずれていた分だけ動かします。文字と枠がすべて同じだけ動きます。印刷するときは、用紙を「はがき」、倍率を「実際のサイズ（100%）」にしてください。
          </p>
        </div>
      </SettingsSection>
    </SettingsStack>
  );

  const backSettings = (
    <SettingsStack testId="postcard-back-settings">
      <SettingsSection n={1} title="はがきの向き" testId="postcard-orientation-section" summary={POSTCARD_ORIENTATION_LABELS[orientation]}>
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
      </SettingsSection>

      <SettingsSection n={2} title="文字と画像を置く" testId="postcard-items-section" bodyClassName="flex flex-col gap-3">
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
      </SettingsSection>

      <SettingsSection n={3} title="PDFにして印刷する" testId="postcard-print-section">
        <p className="text-xs text-ms-muted">
          はがきの大きさのPDFを作ります。印刷するときは、用紙を「はがき」、倍率を「実際のサイズ（100%）」にしてください（「用紙に合わせる」にすると、配置がずれることがあります）。
        </p>
      </SettingsSection>
    </SettingsStack>
  );

  return (
    <div className="flex flex-col gap-6">
      <Segmented
        ariaLabel="作る面"
        testId="postcard-side"
        value={side}
        onChange={(v: PostcardSide) => {
          setSide(v);
          changed();
        }}
        options={[
          { value: "back", label: "文字・画像の面" },
          { value: "address", label: "宛名面" },
        ]}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,460px)] lg:items-start">
        {/* スマホではプレビューを先に（上に）出し、設定を変えながら見られるようにする */}
        <div className="order-first min-w-0 lg:order-none lg:sticky lg:top-20 lg:col-start-2 lg:row-start-1">
          {side === "address" ? <PostcardAddressPreview address={address} /> : preview}
        </div>

        <div className="flex min-w-0 flex-col gap-6 lg:col-start-1 lg:row-start-1">{side === "address" ? addressSettings : backSettings}</div>
      </div>

      {problem && side === "address" && <p className="text-xs text-ms-muted" data-testid="postcard-problem">{problem}</p>}

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
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {side === "address" ? "はがき（100×148mm）の宛名面1枚のPDFです。" : `はがき（100×148mm・${POSTCARD_ORIENTATION_LABELS[orientation]}）1枚のPDFです。`}
          </p>
          <RewardedDownloadGate onDownload={() => downloadBlob(result, side === "address" ? "はがき_宛名面.pdf" : "はがき.pdf")} label="PDFをダウンロード" />
        </ResultPopup>
      )}
    </div>
  );
}
