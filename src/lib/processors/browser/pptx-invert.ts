import { BrowserProcessor } from "../types";
import { invertPptx, PptxInvertError, DEFAULT_PPTX_INVERT_OPTIONS, type PptxInvertOptions, type PptxInvertReport } from "@/lib/pptx/invert-pptx";
import { stripExtension } from "@/lib/utils/format";

/**
 * PowerPoint白黒反転。.pptx を読み込み、白背景・黒文字を黒背景・白文字にした .pptx を作る。
 * 処理はすべてブラウザの中で行い、ファイルはどこにも送信されない。
 */
export interface PptxInvertInput {
  file: File;
  options?: Partial<PptxInvertOptions>;
  onProgress?: (message: string) => void;
}

export interface PptxInvertOutput {
  blob: Blob;
  /** 保存名（元の名前_白黒反転.pptx） */
  suggestedName: string;
  sizeBytes: number;
  report: PptxInvertReport;
  /** 変換に使った設定（AIの判断を使って、同じ設定でもう一度反転するときに使う） */
  options: PptxInvertOptions;
}

export const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export function invertedFileName(original: string): string {
  return `${stripExtension(original)}_白黒反転.pptx`;
}

const STAGE_LABEL = { unzip: "ファイルを開いています...", colors: "色を変換しています...", images: "画像を確認しています...", zip: "ファイルを作成しています..." } as const;

export class PptxInvertProcessor extends BrowserProcessor<PptxInvertInput, PptxInvertOutput> {
  async process({ file, options, onProgress }: PptxInvertInput): Promise<PptxInvertOutput> {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".ppt")) {
      throw new Error("古い形式（.ppt）には対応していません。PowerPointで「.pptx」形式として保存し直してから、もう一度お試しください。");
    }
    if (lower.endsWith(".pptm") || lower.endsWith(".potx") || lower.endsWith(".ppsx")) {
      throw new Error("この形式には対応していません。通常のPowerPointファイル（.pptx）を選んでください。");
    }
    let data: Uint8Array;
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new Error("ファイルの読み込みに失敗しました");
    }
    try {
      const used: PptxInvertOptions = { ...DEFAULT_PPTX_INVERT_OPTIONS, ...options };
      const result = await invertPptx(data, used, undefined, (p) => onProgress?.(STAGE_LABEL[p.stage]));
      const blob = new Blob([result.bytes as BlobPart], { type: PPTX_MIME });
      return { blob, suggestedName: invertedFileName(file.name), sizeBytes: blob.size, report: result.report, options: used };
    } catch (e) {
      if (e instanceof PptxInvertError) throw new Error(e.message);
      throw new Error("変換に失敗しました。ファイルが壊れているか、対応していない内容を含んでいる可能性があります。");
    }
  }
}
