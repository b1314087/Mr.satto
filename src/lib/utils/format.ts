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
  const dot = filename.lastIndexOf(".");
  const base = dot === -1 ? filename : filename.slice(0, dot);
  return `${sanitizeFileName(base)}.${newExt}`;
}
