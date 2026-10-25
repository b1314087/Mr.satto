/**
 * 年度カレンダー作成（/tools/fiscal-calendar）の説明文のうち、AIで読み取る機能（課金オン時のみ提供）に
 * 関わる部分。tool-content.ts には課金オン時の文言（on）を元の文章として書き、
 * 課金オフ時（AI・画像の読み取りを提供しない）は feature-copy.ts が off の文言へ差し替える。
 *
 * ここに書く内容は、画面の案内（fiscal-calendar-events-import.tsx）・プライバシーポリシー 3-2 と一致させること。
 * - Excel・CSV・文字情報のあるPDFの読み取りは、通常はブラウザの中だけで処理する。
 * - AIで読み取る（プレミアム）は、利用者が内容を確認して同意したときだけ、選んだ内容を外部のAIサービスへ送る。
 *   送る内容は、画像・スキャンPDFでは縮小した画像、Excel・CSVの読み取り補助では選んだ行・列の文字。
 * 実装にない対応形式・送信内容は書かない。
 */

export interface OnOffCopy {
  /** 課金オン（AIで読み取る機能がある）ときの文言 */
  on: string;
  /** 課金オフ（AIで読み取る機能がない）ときの文言 */
  off: string;
}

/**
 * メタディスクリプション全体（検索結果に出る説明）。長くしすぎないよう、機能・出力形式・対応ファイル・
 * 処理の場所（ブラウザ内）・AI利用時の条件（同意のうえ外部へ送信）だけを簡潔に書く。
 */
export const FISCAL_CALENDAR_META_DESCRIPTION: OnOffCopy = {
  on: "年度（4月〜翌年3月）の祝日入りカレンダーを、Excel（月別12シート）またはPDF（月別12ページ）で無料作成。予定表（Excel・CSV・PDF・画像）も取り込めます。通常はブラウザ内で処理し、AIで読み取る場合（プレミアム）のみ、同意のうえ外部のAIサービスへ送信します。",
  off: "年度（4月〜翌年3月）の祝日入りカレンダーを、Excel（月別12シート）またはPDF（月別12ページ）で無料作成。予定表（Excel・CSV・PDF）も取り込めます。ブラウザ内で処理するので、サーバーへ送信されません。",
};

export const FISCAL_CALENDAR_HOWTO_IMPORT: OnOffCopy = {
  on: "予定を入れたいときは、「予定データ」で、日付・予定・開始時刻・終了時刻が並んだ予定表（Excel（.xlsx）・CSV・PDF・画像（PNG・JPG））を選びます。読み込んだ件数と、読み取れなかった行が表示されます。画像とスキャンしたPDFは、AI（プレミアムの機能）で読み取るため、内容を確認して同意したときだけ、縮小した画像を外部のAIサービスに送ります。",
  off: "予定を入れたいときは、「予定データ」で、日付・予定・開始時刻・終了時刻が並んだ予定表（Excel（.xlsx）・CSV・PDF）を選びます。読み込んだ件数と、読み取れなかった行が表示されます。",
};

export const FISCAL_CALENDAR_IMPORT_QUESTION: OnOffCopy = {
  on: "予定表のファイル（Excel・CSV・PDF・画像）を読み込めますか？",
  off: "予定表のファイル（Excel・CSV・PDF）を読み込めますか？",
};

export const FISCAL_CALENDAR_IMPORT_ANSWER_FORMATS: OnOffCopy = {
  on: "はい。日付・予定・開始時刻・終了時刻の列があるExcel（.xlsx）・CSV・PDF・画像（PNG・JPG）を読み込み、該当する日の予定欄に載せられます。",
  off: "はい。日付・予定・開始時刻・終了時刻の列があるExcel（.xlsx）・CSV・PDFを読み込み、該当する日の予定欄に載せられます。",
};

export const FISCAL_CALENDAR_IMPORT_ANSWER_PRIVACY: OnOffCopy = {
  on: "Excel・CSV・文字のPDFは、通常はこの端末の中だけで処理し、サーバーへ送信しません。画像とスキャンしたPDFは、AI（プレミアムの機能）で読み取ります。AIで読み取るのは、内容を確認して同意したときだけです。その場合、縮小した画像（Excel・CSVの読み取り補助では、選んだ行・列の文字）を外部のAIサービスに送ります。",
  off: "ファイルの中身はこの端末の中だけで処理し、サーバーへ送信しません。",
};

export const FISCAL_CALENDAR_NO_UPLOAD_ANSWER: OnOffCopy = {
  on: "通常の作成と、Excel・CSV・文字のPDFの読み込みは、すべてお使いのブラウザの中で行われ、ファイルの内容がMr.Sattoのサーバーへ送信されることはありません。処理が終わっても、ページを閉じればデータはブラウザ上から消えます。ただし、AIで読み取る補助（プレミアムの機能）を使う場合に限り、確認・同意のうえで選んだ内容（縮小した画像、または選んだ行・列の文字）が、Mr.Sattoのサーバーを経由して外部のAIサービスへ送信されます。",
  off: "いいえ。このツールの処理はすべてお使いのブラウザの中で行われ、ファイルの内容がMr.Sattoのサーバーへ送信されることはありません。処理が終わっても、ページを閉じればデータはブラウザ上から消えます。",
};

/** 課金オンの文言 → 課金オフの文言 の組（feature-copy.ts が、課金オフのときに文言を差し替えるために使う） */
export const FISCAL_CALENDAR_COPY_PAIRS: OnOffCopy[] = [
  FISCAL_CALENDAR_META_DESCRIPTION,
  FISCAL_CALENDAR_HOWTO_IMPORT,
  FISCAL_CALENDAR_IMPORT_QUESTION,
  FISCAL_CALENDAR_IMPORT_ANSWER_FORMATS,
  FISCAL_CALENDAR_IMPORT_ANSWER_PRIVACY,
  FISCAL_CALENDAR_NO_UPLOAD_ANSWER,
];
