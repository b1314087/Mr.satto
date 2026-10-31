import { runWithDownloadAccess } from "@/lib/download/download-gate";
import { captureIfActive } from "@/lib/handoff/capture";

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const value = bytes / Math.pow(1024, exponent);
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Blobを実際にダウンロードとして保存する（広告の関所を通さない）。
 * ツール側から直接呼ばず、通常は downloadBlob() を使う。
 * 関所（src/lib/download/download-gate.ts）が、広告視聴後にユーザーの
 * クリックの中で保留していた保存を実行する際に使う。
 */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  // 最後の砦として、保存名をここでも無害化する（呼び出し側が通していない名前や、ユーザーのファイル名由来の値に備える。何度通しても同じ結果）
  a.download = sanitizeFileName(filename);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // メモリリークを避けるため少し遅らせて解放する
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * 全ツール共通のダウンロード関数。
 *
 * 無料ユーザーで有効な利用権がない場合は、保存を保留して広告の確認画面を表示する
 * （src/lib/download/download-gate.ts、src/components/ads/download-gate-provider.tsx）。
 * それ以外（Standard/Premium、利用権あり、関所のないページ）は、従来どおりすぐに保存する。
 * 呼び出し側のAPI（引数・戻り値）は従来から変わらない。
 *
 * 「ほかのツールで使う」（工程16）で結果を受け取っている間だけは、保存せずに受け取り口へ渡す
 * （src/lib/handoff/capture.ts）。受け渡しの実行時に、この関所と同じ広告の確認を通す。
 */
export function downloadBlob(blob: Blob, filename: string) {
  if (captureIfActive(blob, sanitizeFileName(filename))) return;
  runWithDownloadAccess({ key: blob, label: filename, run: () => saveBlob(blob, filename) });
}

/**
 * base64エンコードされたdata URL（例: QRCode.toDataURL()の出力）を
 * fetch()を使わずに直接Blobへ変換する。
 *
 * data: URLはネットワークリクエストを一切伴わないため、本来fetch()を
 * 使う必要はない。CSPのconnect-srcはfetch/XHRの送信先を制限するもので
 * （data:スキームは含まれていない。img-srcとは別のディレクティブ）、
 * `fetch(dataUrl)` はブラウザ側で「Failed to fetch」として失敗する。
 * atob()による直接デコードはCSPの制約を受けず、かつネットワーク往復も
 * 発生しないため、この用途ではfetch()より正しい実装になる。
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mimeMatch = /^data:(.*?)(;base64)?$/.exec(header);
  const mimeType = mimeMatch?.[1] || "application/octet-stream";
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

/** ファイル名の長さの上限（UTF-8のバイト数）。多くのファイルシステムの上限（255バイト）に、接尾辞を足す余裕を残す */
export const MAX_FILE_NAME_BYTES = 200;

/** Windowsで予約されているデバイス名（拡張子の有無・大文字小文字を問わず、ファイル名に使えない） */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 表示を誤認させる・見えない文字（制御文字、ゼロ幅文字、左右方向の制御文字、行・段落の区切りなど）。ファイル名から取り除く */
const INVISIBLE_OR_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]/g;

/**
 * 対になっていないサロゲート（壊れた文字）を取り除く。保存時にエラーや文字化けの原因になる。
 * 先読み・後読みの正規表現は、古いSafariで構文エラーになるため使わない。
 */
function removeLoneSurrogates(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      }
    } else if (c < 0xdc00 || c > 0xdfff) {
      out += text[i];
    }
  }
  return out;
}

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** 長すぎるファイル名を、拡張子を残したまま、上限のバイト数に収める（文字の途中では切らない） */
function limitFileNameLength(name: string): string {
  if (utf8Length(name) <= MAX_FILE_NAME_BYTES) return name;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 17 ? name.slice(dot) : "";
  let base = ext ? name.slice(0, dot) : name;
  const budget = MAX_FILE_NAME_BYTES - utf8Length(ext);
  const chars = Array.from(base);
  while (chars.length > 0 && utf8Length(chars.join("")) > budget) chars.pop();
  base = chars.join("");
  return `${base}${ext}`;
}

/**
 * ダウンロード・ZIPに使うファイル名を、安全な形に変換する。
 *  - パス区切りや、Windowsで使えない文字（\ / : * ? " < > |）は "_" に置き換える。パス要素（"../" など）は区切りが残らず、上位のフォルダへ出られない。
 *  - 制御文字、ゼロ幅文字、左右方向の制御文字（拡張子を偽装するのに使われる）、壊れたサロゲートは取り除く。
 *  - 先頭のピリオド・空白（隠しファイル化）と、Windowsで問題になる末尾のピリオド・空白は取り除く。
 *  - Windowsの予約名（CON・NUL・COM1・LPT1 など。拡張子がついていても）は、先頭に "_" を付ける。
 *  - 長すぎる名前は、拡張子を残して、UTF-8で200バイトまでに収める。
 *  - 結果が空になる場合は "file" にする。何度適用しても同じ結果になる（冪等）。
 * 日本語などのマルチバイト文字はそのまま維持する（ASCII化はしない）。
 */
export function sanitizeFileName(name: string): string {
  const trim = (text: string) => text.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");

  let result = removeLoneSurrogates(
    (typeof name === "string" ? name : String(name ?? "")).replace(/[\\/:*?"<>|]/g, "_").replace(INVISIBLE_OR_CONTROL_CHARS, ""),
  );
  result = trim(result);
  if (WINDOWS_RESERVED_NAME.test(result.split(".")[0].trim())) result = `_${result}`;
  result = trim(limitFileNameLength(result));
  // サニタイズの結果、空文字になってしまった場合のフォールバック
  return result || "file";
}

export function replaceExtension(filename: string, newExt: string): string {
  return `${stripExtension(filename)}.${newExt}`;
}

/**
 * ファイル名から拡張子を除いた部分（サニタイズ済み）を取り出す。
 * PDF系ツール（結合・分割・削除・並び替え・回転・画像→PDF・バッチ変換等）が
 * 出力ファイル名に接尾辞を付ける際、共通してこの関数を使う
 * （各ツールで同じ処理を再実装しないための共通化）。
 */
export function stripExtension(filename: string): string {
  const sanitized = sanitizeFileName(filename);
  const dot = sanitized.lastIndexOf(".");
  return dot === -1 ? sanitized : sanitized.slice(0, dot);
}

/**
 * ファイル名（サニタイズ済み）から拡張子のみを取り出す（ドットは含まない）。
 * 拡張子がない場合は空文字を返す。
 * ファイル系ツール（一括リネーム・連番リネーム）が「拡張子維持」を
 * 実現するために、元ファイル名から拡張子だけを分離するのに使う。
 */
export function getExtension(filename: string): string {
  const sanitized = sanitizeFileName(filename);
  const dot = sanitized.lastIndexOf(".");
  return dot === -1 ? "" : sanitized.slice(dot + 1);
}

/**
 * 出力ファイル名の一覧に同名が含まれる場合、拡張子の直前に "_2" "_3"...
 * を付加して一意化する（例: photo.jpg, photo.jpg → photo.jpg, photo_2.jpg）。
 * ZIP化・ファイルリネームなど、複数の出力ファイルを同時に扱うツールが
 * 意図せず同名で上書きしてしまわないよう、共通で使う。
 * 付加後の名前が既存の別ファイル名と衝突する場合も、衝突しなくなるまで
 * 番号を増やして再試行する。
 */
export function dedupeFileNames(names: string[]): string[] {
  const used = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    let candidate = name;
    if (used.has(candidate)) {
      const dot = name.lastIndexOf(".");
      const base = dot === -1 ? name : name.slice(0, dot);
      const ext = dot === -1 ? "" : name.slice(dot);
      let n = 2;
      candidate = `${base}_${n}${ext}`;
      while (used.has(candidate)) {
        n += 1;
        candidate = `${base}_${n}${ext}`;
      }
    }
    used.add(candidate);
    result.push(candidate);
  }
  return result;
}
