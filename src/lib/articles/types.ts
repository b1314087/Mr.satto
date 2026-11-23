/**
 * 使い方ガイド（記事）の型（2026-11-23）。
 *
 * 記事は Markdown や HTML ではなく、決まった形のかたまり（ArticleBlock）の並びで書く。
 * - 画面に出すときに HTML をそのまま差し込まないので、書き間違いで表示が崩れたり、危ない内容が混ざったりしない。
 * - ツールへの案内（tool）は、ツールの一覧（src/lib/tools/data.ts）のIDで書く。存在しないIDはテストで見つける。
 */

export type ArticleBlock =
  /** 段落 */
  | { t: "p"; text: string }
  /** 大見出し（目次に出る）。id はページ内リンク用（英数字とハイフン） */
  | { t: "h2"; id: string; text: string }
  /** 小見出し */
  | { t: "h3"; text: string }
  /** 箇条書き */
  | { t: "ul"; items: string[] }
  /** 番号付きの手順 */
  | { t: "ol"; items: string[] }
  /** ポイント（役に立つ一言） */
  | { t: "tip"; title?: string; text: string }
  /** 注意 */
  | { t: "warn"; text: string }
  /** 表 */
  | { t: "table"; head: string[]; rows: string[][]; caption?: string }
  /** 例文・見本（改行をそのまま見せる） */
  | { t: "example"; title: string; lines: string[] }
  /** ツールへの案内カード */
  | { t: "tool"; id: string; note?: string }
  /** ほかの記事への案内 */
  | { t: "guide"; slug: string; note?: string };

export interface Article {
  /** URL の最後の部分（/guides/〇〇）。英小文字・数字・ハイフン */
  slug: string;
  title: string;
  /** 検索結果・一覧に出す説明（120字前後） */
  description: string;
  /** 記事の分野（一覧の見出し・絞り込み用） */
  topic: "PDF" | "画像" | "Excel・CSV" | "書類作成" | "安全・プライバシー" | "動画・音声";
  /** 公開日・更新日（YYYY-MM-DD） */
  publishedAt: string;
  updatedAt: string;
  /** 記事の最初に出す、要点の一文 */
  lead: string;
  /** この記事で使うツール（記事の最後と、ツールのページの「関連ガイド」に出す） */
  relatedTools: string[];
  blocks: ArticleBlock[];
}
