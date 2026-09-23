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

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // メモリリークを避けるため少し遅らせて解放する
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/**
 * Windowsでも安全に保存できるファイル名に変換する。
 * \ / : * ? " < > | 、および制御文字を "_" に置換し、
 * Windowsで問題になりやすい末尾のピリオド・スペースも取り除く。
 * 日本語などのマルチバイト文字はそのまま維持する（ASCII化はしない）。
 */
export function sanitizeFileName(name: string): string {
  const withoutForbiddenChars = name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/[\x00-\x1f]/g, "");
  const withoutTrailingDotsOrSpaces = withoutForbiddenChars.replace(/[.\s]+$/g, "");
  // サニタイズの結果、空文字になってしまった場合のフォールバック
  return withoutTrailingDotsOrSpaces || "file";
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
