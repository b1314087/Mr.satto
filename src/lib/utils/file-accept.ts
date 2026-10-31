/**
 * `accept` に指定されたパターン（MIMEタイプ／"image/*"／".csv" のような拡張子）
 * のいずれかにファイルが一致するかを判定する。
 * ファイル選択ダイアログの `accept` 属性はドラッグ&ドロップには効かないため、
 * ドロップ時にも同じ判定を通すために使う（共通のファイル選択欄 FileDropzone）。
 * ツール間の受け渡し（工程16）で受け取ったファイルにも、同じ判定を通す。
 */
export function matchesAccept(file: { name: string; type: string }, accept: string): boolean {
  const patterns = accept
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (patterns.length === 0) return true;

  const name = file.name.toLowerCase();
  const type = (file.type || "").toLowerCase();

  return patterns.some((pattern) => {
    if (pattern.startsWith(".")) {
      return name.endsWith(pattern);
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, pattern.indexOf("/"));
      return type.startsWith(`${prefix}/`);
    }
    return type === pattern;
  });
}
