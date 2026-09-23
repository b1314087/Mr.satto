/**
 * CSV/Excelの内容確認用プレビュー共通コンポーネント。
 * CSV→Excel・Excel→CSV・CSV結合・CSV重複削除・CSV文字置換の5ツールが
 * 共通で使う（各ツールへ同じプレビューUIをコピーしない）。
 *
 * table-fixed + truncate により、列数が多いCSVでもスマートフォンで
 * 横スクロールが発生しないようにしている（列を省略して幅内に収める）。
 */
export function CsvPreviewTable({
  rows,
  maxRows = 8,
  maxCols = 6,
}: {
  rows: string[][];
  maxRows?: number;
  maxCols?: number;
}) {
  if (rows.length === 0) return null;

  const totalCols = Math.max(...rows.map((row) => row.length));
  const colCount = Math.min(maxCols, totalCols);
  const displayRows = rows.slice(0, maxRows);
  const rowsTruncated = rows.length > maxRows;
  const colsTruncated = totalCols > maxCols;

  return (
    <div className="flex flex-col gap-1">
      <table className="w-full table-fixed border-collapse overflow-hidden rounded-lg border border-neutral-200 text-xs dark:border-neutral-800">
        <tbody>
          {displayRows.map((row, i) => (
            <tr key={i} className={i === 0 ? "bg-neutral-100 font-medium dark:bg-neutral-800" : ""}>
              {Array.from({ length: colCount }).map((_, j) => (
                <td
                  key={j}
                  title={row[j] ?? ""}
                  className="truncate border border-neutral-200 px-2 py-1 text-neutral-700 dark:border-neutral-800 dark:text-neutral-200"
                >
                  {row[j] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(rowsTruncated || colsTruncated) && (
        <p className="text-xs text-neutral-400 dark:text-neutral-500">
          プレビューは{rowsTruncated ? `先頭${maxRows}行` : "全行"}
          {colsTruncated ? `・先頭${maxCols}列` : ""}のみ表示しています（全{rows.length}行
          {colsTruncated ? `・全${totalCols}列` : ""}）
        </p>
      )}
    </div>
  );
}
