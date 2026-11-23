import type { Article, ArticleBlock } from "./types";
import { filledPdfToList } from "./content/filled-pdf-to-list";
import { coverLetterGuide } from "./content/cover-letter-guide";
import { imageResizeCompress } from "./content/image-resize-compress";
import { pdfCompressGuide } from "./content/pdf-compress-guide";
import { pdfMergeSplit } from "./content/pdf-merge-split";
import { warekiGuide } from "./content/wareki-guide";
import { photoExifRemove } from "./content/photo-exif-remove";
import { csvMojibake } from "./content/csv-mojibake";
import { envelopeAddressGuide } from "./content/envelope-address-guide";
import { receiptToAccounting } from "./content/receipt-to-accounting";
import { shiftScheduleGuide } from "./content/shift-schedule-guide";
import { rosterExcelGuide } from "./content/roster-excel-guide";
import { excelToPdfLayout } from "./content/excel-to-pdf-layout";
import { invoiceEstimateGuide } from "./content/invoice-estimate-guide";
import { seatingChartGuide } from "./content/seating-chart-guide";
import { paperSurveyGuide } from "./content/paper-survey-guide";
import { schoolYearCalendar } from "./content/school-year-calendar";
import { pdfRedactionGuide } from "./content/pdf-redaction-guide";
import { electronicSealGuide } from "./content/electronic-seal-guide";
import { screenRecordingManual } from "./content/screen-recording-manual";
import { pdfPasswordGuide } from "./content/pdf-password-guide";

export type { Article, ArticleBlock } from "./types";

/**
 * 使い方ガイド（記事）の一覧（2026-11-23）。新しい記事は、ここに足す（一覧は新しい順に並べて出す）。
 */
export const articles: Article[] = [
  filledPdfToList,
  coverLetterGuide,
  imageResizeCompress,
  pdfCompressGuide,
  pdfMergeSplit,
  csvMojibake,
  warekiGuide,
  photoExifRemove,
  envelopeAddressGuide,
  receiptToAccounting,
  // 2026-11-23（2回目）：学校・事務・小さな事業でよく困ることの記事を追加
  shiftScheduleGuide,
  rosterExcelGuide,
  excelToPdfLayout,
  invoiceEstimateGuide,
  seatingChartGuide,
  paperSurveyGuide,
  schoolYearCalendar,
  pdfRedactionGuide,
  electronicSealGuide,
  pdfPasswordGuide,
  screenRecordingManual,
];

export function getArticle(slug: string): Article | undefined {
  return articles.find((a) => a.slug === slug);
}

/** 新しい順（公開日→一覧の順） */
export function sortedArticles(): Article[] {
  return [...articles].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1 : 0));
}

/** そのツールを使う記事（ツールのページの「関連する使い方ガイド」用） */
export function articlesForTool(toolId: string): Article[] {
  return articles.filter((a) => a.relatedTools.includes(toolId));
}

/** 記事の文字数（目次・見出し・本文・表・例文を合わせた、おおよその量） */
export function articleCharCount(a: Article): number {
  const blockText = (b: ArticleBlock): string => {
    switch (b.t) {
      case "p":
      case "h2":
      case "h3":
      case "warn":
        return b.text;
      case "tip":
        return `${b.title ?? ""}${b.text}`;
      case "ul":
      case "ol":
        return b.items.join("");
      case "table":
        return [...b.head, ...b.rows.flat(), b.caption ?? ""].join("");
      case "example":
        return b.title + b.lines.join("");
      case "tool":
      case "guide":
        return b.note ?? "";
    }
  };
  return (a.lead + a.blocks.map(blockText).join("")).replace(/\s/g, "").length;
}

/** 読む時間のめやす（分）。日本語はおよそ1分500字 */
export function readingMinutes(a: Article): number {
  return Math.max(1, Math.round(articleCharCount(a) / 500));
}

/** 目次（大見出し） */
export function tableOfContents(a: Article): { id: string; text: string }[] {
  return a.blocks.flatMap((b) => (b.t === "h2" ? [{ id: b.id, text: b.text }] : []));
}

/** 記事の中で案内しているツール（本文のカード＋関連ツール。重なりなし） */
export function toolsInArticle(a: Article): string[] {
  const ids = new Set<string>(a.relatedTools);
  for (const b of a.blocks) if (b.t === "tool") ids.add(b.id);
  return [...ids];
}
