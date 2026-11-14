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
import { FileDropzone } from "@/components/common/file-dropzone";
import { CsvEncodingControl } from "@/components/common/csv-encoding-control";
import { featureFlags } from "@/lib/config/features";
import { parseTableFile, type ParsedTableFile } from "@/lib/utils/table-file";
import { applyRecipient, type PostcardRecipient } from "@/lib/print/postcard-address-layout";
import {
  POSTCARD_RECIPIENTS_MAX,
  addressFromZip,
  buildRecipients,
  guessRecipientColumns,
  recipientColumnsError,
  type RecipientColumns,
} from "@/lib/print/postcard-recipients";
import { PlanLimitHint, usePlanLimit } from "@/components/common/plan-limit";

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
  // 2026-11：初期画面は宛名面（よく使う面を先に）
  const [side, setSide] = useState<PostcardSide>("address");
  const [address, setAddress] = useState<PostcardAddressInput>(defaultPostcardAddress);
  // 郵便番号から自動で入れた住所（利用者が書き換えたら、もう上書きしない）
  const autoAddressRef = useRef<{ recipient: string; sender: string }>({ recipient: "", sender: "" });
  const [zipNote, setZipNote] = useState<{ recipient: string | null; sender: string | null }>({ recipient: null, sender: null });
  // 料金プランの上限（Excel・CSVでまとめて作る宛先の件数）。スタンダードは10件、プレミアムは500件、無料（1件）は1枚ずつの作成だけ。
  // 処理の直前に、サーバーでもプランを確かめる（recipientLimit.confirmCount）
  const recipientLimit = usePlanLimit("postcard");
  const bulkAllowed = recipientLimit.limit > 1;
  const maxRecipients = Math.min(POSTCARD_RECIPIENTS_MAX, recipientLimit.limit);
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkTable, setBulkTable] = useState<ParsedTableFile | null>(null);
  const [bulkColumns, setBulkColumns] = useState<RecipientColumns | null>(null);
  const [recipients, setRecipients] = useState<PostcardRecipient[] | null>(null);
  const [bulkInfo, setBulkInfo] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [previewIndex, setPreviewIndex] = useState(0);
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

  /**
   * 郵便番号を入れたら、住所（都道府県〜町域）を自動で入れる。住所が空か、前に自動で入れたままのときだけ入れる
   * （利用者が書いた住所は上書きしない）。番地・建物名は、続けて入力してもらう。
   */
  async function handleZipChange(which: "recipient" | "sender", value: string) {
    updateAddress(which === "recipient" ? { recipientZip: value } : { senderZip: value });
    const found = await addressFromZip(value);
    if (!found) {
      setZipNote((prev) => ({ ...prev, [which]: null }));
      return;
    }
    setAddress((prev) => {
      const current = which === "recipient" ? prev.recipientAddress : prev.senderAddress;
      const auto = autoAddressRef.current[which];
      if (current.trim() !== "" && current !== auto) return prev;
      autoAddressRef.current[which] = found;
      return which === "recipient" ? { ...prev, recipientAddress: found } : { ...prev, senderAddress: found };
    });
    setZipNote((prev) => ({ ...prev, [which]: `郵便番号から「${found}」を入れました。番地・建物名を続けて入力してください。` }));
    changed();
  }

  async function loadBulkFile(f: File) {
    setBulkFile(f);
    setBulkError(null);
    setBulkInfo(null);
    setRecipients(null);
    setBulkTable(null);
    changed();
    try {
      const t = await parseTableFile(f);
      const cols = guessRecipientColumns(t.headers);
      setBulkTable(t);
      setBulkColumns(cols);
      await applyBulk(t, cols);
    } catch (e) {
      setBulkError(e instanceof Error ? e.message : "ファイルを読み込めませんでした。");
    }
  }

  async function applyBulk(t: ParsedTableFile, cols: RecipientColumns) {
    setBulkError(null);
    const colProblem = recipientColumnsError(cols);
    if (colProblem) {
      setRecipients(null);
      setBulkError(colProblem);
      return;
    }
    const built = await buildRecipients(t, cols);
    if (built.recipients.length === 0) {
      setRecipients(null);
      setBulkError("宛先の行がありません（1行目は見出しとして扱います）。");
      return;
    }
    if (built.recipients.length > maxRecipients) {
      setRecipients(null);
      setBulkError(`一度に作れるのは${maxRecipients}件までです（${built.recipients.length}件あります）。ファイルを分けてください。`);
      return;
    }
    setRecipients(built.recipients);
    setPreviewIndex(0);
    setBulkInfo(
      `${built.recipients.length}件の宛先を読み込みました。` +
        (built.filledFromZip > 0 ? `住所が空の${built.filledFromZip}件は、郵便番号から住所を入れました。` : "") +
        (built.skipped > 0 ? `空の${built.skipped}行は飛ばしました。` : "")
    );
    changed();
  }

  function clearBulk() {
    setBulkFile(null);
    setBulkTable(null);
    setBulkColumns(null);
    setRecipients(null);
    setBulkInfo(null);
    setBulkError(null);
    setPreviewIndex(0);
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
      if (side === "address" && recipients && !(await recipientLimit.confirmCount(recipients.length))) {
        setError(`今のプランでまとめて作れる宛先は${recipientLimit.limit.toLocaleString("ja-JP")}件までです（今は${recipients.length.toLocaleString("ja-JP")}件）。`);
        setStatus("error");
        return;
      }
      const out =
        side === "address"
          ? await new PostcardAddressProcessor().process({ ...address, recipients: recipients ?? undefined })
          : await new PostcardProcessor().process({ orientation, texts, images });
      setResult(out.blob);
      setStatus("success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "PDFを作成できませんでした");
      setStatus("error");
    }
  }

  // 複数の宛先を読み込んだときは、プレビューで選んでいる宛先を当てはめた内容を、プレビュー・確認に使う
  const shownAddress = recipients && recipients.length > 0 ? applyRecipient(address, recipients[Math.min(previewIndex, recipients.length - 1)]) : address;
  const problem =
    side === "address"
      ? recipients && recipients.length > 0
        ? (recipients.map((r, i) => {
            const p = validatePostcardAddress(applyRecipient(address, r));
            return p ? `${i + 1}件目：${p}` : null;
          }).find((p) => p !== null) ?? null)
        : validatePostcardAddress(address)
      : validatePostcard(texts, images);
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

  const colLabel = (i: number) => (bulkTable ? bulkTable.headers[i] || `${i + 1}列目` : "");
  const columnSelect = (key: keyof RecipientColumns, label: string, optional: boolean) =>
    bulkTable && bulkColumns ? (
      <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
        {label}
        <select
          value={bulkColumns[key]}
          data-testid={`postcard-bulk-col-${key}`}
          onChange={(e) => {
            const next = { ...bulkColumns, [key]: Number(e.target.value) };
            setBulkColumns(next);
            void applyBulk(bulkTable, next);
          }}
          className="rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-sm font-normal dark:border-neutral-700 dark:bg-neutral-900"
        >
          {optional && <option value={-1}>（使わない）</option>}
          {!optional && <option value={-1}>（選んでください）</option>}
          {bulkTable.headers.map((_, i) => (
            <option key={i} value={i}>
              {colLabel(i)}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  const bulkSection = (
    <SettingsSection
      n={1}
      title={featureFlags.billing ? "Excel・CSVで複数の宛先を読み込む（プレミアム）" : "Excel・CSVで複数の宛先を読み込む"}
      testId="postcard-bulk-section"
      summary={recipients ? `${recipients.length}件` : "任意"}
      defaultOpen
    >
      {!bulkAllowed ? (
        <p className="text-sm text-ms-text" data-testid="postcard-bulk-premium-note">
          Excel・CSVから複数の宛先を読み込んで、まとめて宛名面を作る機能は、プレミアムプランでご利用いただけます。1枚ずつの作成は、このまま無料でお使いいただけます。
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          <FileDropzone
            compact={!!bulkFile}
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            maxSizeMB={20}
            label="Excel・CSVをドラッグ&ドロップ"
            hint="またはタップして選択（.xlsx・.csv）"
            onFilesSelected={(files) => files[0] && void loadBulkFile(files[0])}
            onError={setBulkError}
            pageDrop={false}
          />
          <PlanLimitHint state={recipientLimit} />
          <CsvEncodingControl files={[bulkFile]} onChange={(f) => void loadBulkFile(f)} />
          {bulkTable && bulkColumns && (
            <div className="grid grid-cols-2 gap-2" data-testid="postcard-bulk-columns">
              {columnSelect("zip", "郵便番号の列", true)}
              {columnSelect("name", "氏名の列", false)}
              {columnSelect("address1", "住所の列", false)}
              {columnSelect("address2", "住所2（建物名など）の列", true)}
              {columnSelect("honorific", "敬称の列（様・御中・なし）", true)}
            </div>
          )}
          {bulkInfo && (
            <p className="text-xs text-emerald-700 dark:text-emerald-300" data-testid="postcard-bulk-info">
              {bulkInfo}
            </p>
          )}
          {bulkError && <ErrorMessage message={bulkError} />}
          {bulkFile && (
            <button type="button" onClick={clearBulk} data-testid="postcard-bulk-clear" className="w-fit rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800">
              読み込みをやめて、1枚ずつ入力する
            </button>
          )}
        </div>
      )}
    </SettingsSection>
  );

  const addressSettings = (
    <SettingsStack testId="postcard-address-settings">
      {bulkSection}
      <SettingsSection n={2} title="宛先" testId="postcard-recipient-section" summary={recipients ? `読み込んだ${recipients.length}件` : address.recipientName.trim() || "未入力"}>
        <div className="flex flex-col gap-3">
          {recipients && (
            <p className="text-xs text-ms-muted" data-testid="postcard-recipient-bulk-note">
              読み込んだ{recipients.length}件の宛先を使います。プレビューの「前・次」で1件ずつ確かめられます。敬称の列が無い・空の行は、下で選んだ敬称を使います。
            </p>
          )}
          {!recipients && (
            <>
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
              郵便番号（7けた）
              <input
                value={address.recipientZip}
                onChange={(e) => void handleZipChange("recipient", e.target.value)}
                inputMode="numeric"
                autoComplete="off"
                maxLength={10}
                placeholder="例：100-0001"
                data-testid="postcard-recipient-zip"
                className={`${fieldClass} w-40`}
              />
            </label>
            {zipNote.recipient && (
              <p className="text-xs text-emerald-700 dark:text-emerald-300" data-testid="postcard-recipient-zip-note">
                {zipNote.recipient}
              </p>
            )}
            <label className="flex flex-col gap-1 text-xs font-medium text-neutral-600 dark:text-neutral-300">
              住所
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
            </>
          )}
          <Segmented
            ariaLabel="敬称"
            testId="postcard-honorific"
            value={address.honorific}
            onChange={(v: EnvelopeHonorific) => updateAddress({ honorific: v })}
            options={(["sama", "onchu", "none"] as const).map((h) => ({ value: h, label: HONORIFIC_LABELS[h] }))}
          />
        </div>
      </SettingsSection>

      <SettingsSection n={3} title="差出人" testId="postcard-sender-section" summary={address.useSender ? address.senderName.trim() || "印刷する" : "印刷しない"}>
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
                  onChange={(e) => void handleZipChange("sender", e.target.value)}
                  inputMode="numeric"
                  maxLength={10}
                  placeholder="例：530-0001"
                  data-testid="postcard-sender-zip"
                  className={`${fieldClass} w-40`}
                />
              </label>
              {zipNote.sender && (
                <p className="text-xs text-emerald-700 dark:text-emerald-300" data-testid="postcard-sender-zip-note">
                  {zipNote.sender}
                </p>
              )}
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

      <SettingsSection n={4} title="郵便番号枠" testId="postcard-zip-section" summary={address.printZipFrames ? "枠も印刷する" : "数字だけ印刷する"}>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={address.printZipFrames} onChange={(e) => updateAddress({ printZipFrames: e.target.checked })} data-testid="postcard-print-frames" />
            郵便番号枠の線も印刷する（枠が印刷されていない用紙のとき）
          </label>
        </div>
      </SettingsSection>

      <SettingsSection n={5} title="文字の大きさ・位置" testId="postcard-layout-section">
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
                  />
                  <button
                    type="button"
                    onClick={() => updateAddressBlock(id, { ...DEFAULT_POSTCARD_ADDRESS_BLOCKS[id] })}
                    className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-900/50"
                    data-testid={`postcard-block-reset-${id}`}
                  >
                    <span aria-hidden="true">↺</span>
                    {label}を標準に戻す
                  </button>
                </div>
              </details>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection n={6} title="印刷位置の微調整" testId="postcard-offset-section" summary={address.offsetXmm === 0 && address.offsetYmm === 0 ? "調整なし" : `横${address.offsetXmm}mm・縦${address.offsetYmm}mm`}>
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
          { value: "address", label: "宛名面" },
          { value: "back", label: "文字・画像の面" },
        ]}
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,460px)] lg:items-start">
        {/* スマホではプレビューを先に（上に）出し、設定を変えながら見られるようにする */}
        <div className="order-first min-w-0 lg:order-none lg:sticky lg:top-20 lg:col-start-2 lg:row-start-1">
          {side === "address" ? (
            <div className="flex flex-col gap-2">
              {recipients && recipients.length > 1 && (
                <div className="flex items-center justify-center gap-2 text-sm" data-testid="postcard-bulk-pager">
                  <button type="button" onClick={() => setPreviewIndex((i) => Math.max(0, i - 1))} disabled={previewIndex === 0} className="rounded-md border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700" aria-label="前の宛先">
                    ‹ 前
                  </button>
                  <span data-testid="postcard-bulk-pager-label">
                    {previewIndex + 1} / {recipients.length}件目
                  </span>
                  <button type="button" onClick={() => setPreviewIndex((i) => Math.min(recipients.length - 1, i + 1))} disabled={previewIndex >= recipients.length - 1} className="rounded-md border border-neutral-300 px-2 py-1 disabled:opacity-40 dark:border-neutral-700" aria-label="次の宛先">
                    次 ›
                  </button>
                </div>
              )}
              <PostcardAddressPreview address={shownAddress} />
            </div>
          ) : (
            preview
          )}
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
            {side === "address"
              ? recipients && recipients.length > 0
                ? `はがき（100×148mm）の宛名面${recipients.length}枚（1件1ページ）のPDFです。`
                : "はがき（100×148mm）の宛名面1枚のPDFです。"
              : `はがき（100×148mm・${POSTCARD_ORIENTATION_LABELS[orientation]}）1枚のPDFです。`}
          </p>
          <RewardedDownloadGate
            onDownload={() => downloadBlob(result, side === "address" ? (recipients && recipients.length > 0 ? `はがき_宛名面_${recipients.length}件.pdf` : "はがき_宛名面.pdf") : "はがき.pdf")}
            label="PDFをダウンロード"
          />
        </ResultPopup>
      )}
    </div>
  );
}
