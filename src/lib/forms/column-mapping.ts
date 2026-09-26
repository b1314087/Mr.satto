import type { ColumnMapping, FieldDefinition } from "./types";

/**
 * CSV/Excelの列名とPDFフィールドの自動マッピング（開発指示書22章・41章）。
 *
 * 「名前列→住所フィールド」のような取り違えを防ぐため、自動推定は
 * 「フィールドのラベルと列見出しが完全一致（前後の空白除去・大文字小文字を
 * 区別しない比較）」する場合のみに限定する。あいまいな類似度判定・部分一致・
 * 同義語辞書などは一切行わない。一致しない場合は必ず未設定(null)のままにし、
 * 最終的な確定はユーザー自身の確認画面（UI側）に委ねる。
 */
function normalize(value: string): string {
  return value.trim().toLowerCase();
}

export function autoMapColumns(fields: FieldDefinition[], headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const normalizedHeaders = headers.map((h) => ({ original: h, normalized: normalize(h) }));

  for (const field of fields) {
    const normalizedLabel = normalize(field.label);
    const match = normalizedHeaders.find((h) => h.normalized === normalizedLabel);
    mapping[field.id] = match ? match.original : null;
  }

  return mapping;
}

/** マッピングが完了しているか（全フィールドに列が割り当てられているか）を確認する */
export function isMappingComplete(fields: FieldDefinition[], mapping: ColumnMapping): boolean {
  return fields.every((f) => Boolean(mapping[f.id]));
}
