/**
 * アンケート用紙作成（2026-11-17）のデータの形。
 *
 * 画面の編集・紙のプレビュー・PDF・Word・ブラウザ内の保存は、すべてこの形のデータを使う。
 * Webで回答を集める機能はない（紙で配る・回収するための用紙を作る）。
 */

export type QuestionType = "single" | "multiple" | "short" | "long" | "rating" | "scale" | "number" | "date" | "section";

export interface Question {
  id: string;
  type: QuestionType;
  /** 質問文（セクションのときは見出し） */
  title: string;
  /** 質問の説明（セクションのときは説明文） */
  description: string;
  required: boolean;
  /** 単一選択・複数選択の選択肢 */
  options: string[];
  /** 選択肢の最後に「その他（　　）」を付ける */
  other: boolean;
  /** 紙での選択肢の並べ方：縦に1つずつ・横に並べる */
  direction: "vertical" | "horizontal";
  /** 長文記述の記入欄の行数 */
  lines: number;
  /** 短文記述・数値記入の記入欄の長さ */
  width: "short" | "medium" | "full";
  /** 評価の段階の数（3〜10） */
  ratingMax: number;
  /** 評価の表し方：星・数字 */
  ratingStyle: "star" | "number";
  /** 評価の両端の言葉（例：不満 ← → 満足） */
  ratingLow: string;
  ratingHigh: string;
  /** 段階評価の段階の名前 */
  scale: string[];
  /** 数値記入の単位（例：歳・人・回） */
  unit: string;
  /** 日付記入の書き方 */
  dateStyle: "ymd" | "wareki";
}

export interface InfoField {
  id: string;
  label: string;
  enabled: boolean;
}

export type TemplateId = "simple" | "business" | "school" | "event" | "stylish";
export type HeadingStyle = "bar" | "underline" | "box" | "plain";

export interface SurveyDesign {
  template: TemplateId;
  orientation: "portrait" | "landscape";
  /** 本文の文字の大きさ（pt） */
  fontSize: number;
  /** タイトルの文字の大きさ（pt） */
  titleSize: number;
  titleAlign: "left" | "center";
  /** 用紙の余白（mm） */
  margin: number;
  /** 質問と質問の間（mm） */
  spacing: number;
  /** 記入欄の高さの倍率（1 = 標準） */
  answerScale: number;
  headingStyle: HeadingStyle;
  /** 見出し・記号の色（#rrggbb） */
  accent: string;
  /** 質問の番号（Q1 など）を付ける */
  numbering: boolean;
  /** 「必須」の印を付ける */
  showRequired: boolean;
  /** ページ番号を付ける */
  pageNumbers: boolean;
  /** 長文記述の記入欄に罫線を引く */
  ruledLines: boolean;
}

export interface Survey {
  version: 1;
  title: string;
  description: string;
  /** 回答者への案内 */
  guide: string;
  /** 回答時の注意事項 */
  notes: string;
  /** 氏名・所属・回答日などの記入欄 */
  fields: InfoField[];
  questions: Question[];
  design: SurveyDesign;
}

export const QUESTION_TYPES: { type: QuestionType; label: string; hint: string }[] = [
  { type: "single", label: "単一選択", hint: "○ から1つ選ぶ" },
  { type: "multiple", label: "複数選択", hint: "□ からいくつでも選ぶ" },
  { type: "short", label: "短文記述", hint: "1行の記入欄" },
  { type: "long", label: "長文記述", hint: "複数行の記入欄" },
  { type: "rating", label: "評価", hint: "★★★★★ や 1〜5" },
  { type: "scale", label: "段階評価", hint: "とても良い〜とても悪い" },
  { type: "number", label: "数値記入", hint: "年齢・人数など" },
  { type: "date", label: "日付記入", hint: "年・月・日" },
  { type: "section", label: "セクション", hint: "質問のまとまりの見出し" },
];

export const TYPE_LABEL: Record<QuestionType, string> = Object.fromEntries(QUESTION_TYPES.map((t) => [t.type, t.label])) as Record<QuestionType, string>;

export const DEFAULT_SCALE = ["とても良い", "良い", "普通", "悪い", "とても悪い"];

export const SCALE_PRESETS: { label: string; values: string[] }[] = [
  { label: "良い〜悪い（5段階）", values: DEFAULT_SCALE },
  { label: "満足〜不満（5段階）", values: ["満足", "やや満足", "どちらでもない", "やや不満", "不満"] },
  { label: "そう思う〜思わない（4段階）", values: ["そう思う", "ややそう思う", "あまりそう思わない", "そう思わない"] },
  { label: "はい・いいえ・わからない", values: ["はい", "いいえ", "わからない"] },
];

export const LIMITS = {
  questions: 200,
  options: 30,
  scale: 10,
  fields: 8,
  text: 2000,
  shortText: 200,
  lines: 30,
};

let counter = 0;
export function newId(prefix = "q"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function newQuestion(type: QuestionType): Question {
  const base: Question = {
    id: newId(),
    type,
    title: "",
    description: "",
    required: false,
    options: [],
    other: false,
    direction: "vertical",
    lines: 4,
    width: "full",
    ratingMax: 5,
    ratingStyle: "star",
    ratingLow: "",
    ratingHigh: "",
    scale: [...DEFAULT_SCALE],
    unit: "",
    dateStyle: "ymd",
  };
  switch (type) {
    case "single":
      return { ...base, title: "質問を入力してください", options: ["選択肢1", "選択肢2", "選択肢3"] };
    case "multiple":
      return { ...base, title: "あてはまるものをすべて選んでください", options: ["選択肢1", "選択肢2", "選択肢3"] };
    case "short":
      return { ...base, title: "質問を入力してください" };
    case "long":
      return { ...base, title: "ご意見・ご感想をご自由にお書きください" };
    case "rating":
      return { ...base, title: "満足度を教えてください", ratingLow: "不満", ratingHigh: "満足" };
    case "scale":
      return { ...base, title: "評価を選んでください" };
    case "number":
      return { ...base, title: "年齢を教えてください", unit: "歳", width: "short" };
    case "date":
      return { ...base, title: "日付を記入してください" };
    case "section":
      return { ...base, title: "セクションの見出し" };
  }
}

/** 形式を変える。入力した質問文・説明・必須は残し、選択肢などは、使えるものは引き継ぐ */
export function changeType(q: Question, type: QuestionType): Question {
  if (q.type === type) return q;
  const fresh = newQuestion(type);
  const keepOptions = (type === "single" || type === "multiple") && q.options.length > 0;
  return {
    ...fresh,
    id: q.id,
    title: q.title || fresh.title,
    description: q.description,
    required: type === "section" ? false : q.required,
    options: keepOptions ? q.options : fresh.options,
    other: keepOptions ? q.other : false,
    direction: q.direction,
    lines: q.lines,
    scale: q.scale.length >= 2 ? q.scale : fresh.scale,
    unit: type === "number" ? q.unit || fresh.unit : q.unit,
  };
}

export function duplicateQuestion(q: Question): Question {
  return { ...q, id: newId(), options: [...q.options], scale: [...q.scale] };
}

export const DEFAULT_FIELDS: InfoField[] = [
  { id: "name", label: "氏名", enabled: false },
  { id: "group", label: "所属（学年・クラス）", enabled: false },
  { id: "date", label: "回答日", enabled: false },
];

// ---------------------------------------------------------------------------
// テンプレート（見た目の設定。質問の内容は変えない）
// ---------------------------------------------------------------------------

export interface TemplateDef {
  id: TemplateId;
  label: string;
  description: string;
  design: Omit<SurveyDesign, "template" | "orientation" | "pageNumbers">;
  /** 「このテンプレートの質問例を使う」を押したときの内容（確認してから入れ替える） */
  sample: () => Pick<Survey, "title" | "description" | "guide" | "notes" | "fields" | "questions">;
}

function q(type: QuestionType, patch: Partial<Question>): Question {
  return { ...newQuestion(type), ...patch };
}

export const TEMPLATES: TemplateDef[] = [
  {
    id: "simple",
    label: "シンプル",
    description: "黒と灰色だけの、どんな場面にも合う用紙",
    design: { fontSize: 10.5, titleSize: 18, titleAlign: "center", margin: 18, spacing: 6, answerScale: 1, headingStyle: "underline", accent: "#333333", numbering: true, showRequired: true, ruledLines: true },
    sample: () => ({
      title: "アンケート",
      description: "今後の参考にさせていただきますので、ご協力をお願いいたします。",
      guide: "",
      notes: "",
      fields: DEFAULT_FIELDS.map((f) => ({ ...f })),
      questions: [
        q("single", { title: "満足度を教えてください", options: ["満足", "やや満足", "やや不満", "不満"], direction: "horizontal", required: true }),
        q("long", { title: "ご意見・ご感想をご自由にお書きください", lines: 5 }),
      ],
    }),
  },
  {
    id: "business",
    label: "ビジネス",
    description: "紺色の見出し帯で、セミナー・社内調査に",
    design: { fontSize: 10.5, titleSize: 17, titleAlign: "left", margin: 18, spacing: 6, answerScale: 1, headingStyle: "bar", accent: "#1f3a68", numbering: true, showRequired: true, ruledLines: true },
    sample: () => ({
      title: "セミナー参加者アンケート",
      description: "本日はご参加いただき、誠にありがとうございました。今後の改善のため、アンケートへのご協力をお願いいたします。",
      guide: "該当するものに○を付け、記述欄にはご自由にご記入ください。",
      notes: "ご回答いただいた内容は、統計的に処理し、個人が特定される形で公表することはありません。",
      fields: [
        { id: "name", label: "氏名", enabled: true },
        { id: "group", label: "会社名・部署", enabled: true },
        { id: "date", label: "回答日", enabled: false },
      ],
      questions: [
        q("section", { title: "セミナーについて" }),
        q("scale", { title: "セミナーの内容はいかがでしたか", scale: ["満足", "やや満足", "どちらでもない", "やや不満", "不満"], required: true }),
        q("single", { title: "内容の難易度はいかがでしたか", options: ["難しい", "ちょうど良い", "易しい"], direction: "horizontal" }),
        q("multiple", { title: "このセミナーを何で知りましたか（複数回答可）", options: ["メール", "Webサイト", "SNS", "知人の紹介"], other: true, direction: "horizontal" }),
        q("section", { title: "今後について" }),
        q("rating", { title: "次回も参加したいと思いますか", ratingStyle: "number", ratingLow: "思わない", ratingHigh: "思う" }),
        q("long", { title: "ご意見・ご要望をご自由にお書きください", lines: 5 }),
      ],
    }),
  },
  {
    id: "school",
    label: "学校向け",
    description: "大きめの文字と枠で、児童・生徒・保護者に",
    design: { fontSize: 12, titleSize: 20, titleAlign: "center", margin: 16, spacing: 7, answerScale: 1.2, headingStyle: "box", accent: "#2e7d32", numbering: true, showRequired: false, ruledLines: true },
    sample: () => ({
      title: "学校生活アンケート",
      description: "学校生活をよりよくするためのアンケートです。思ったとおりに答えてください。",
      guide: "あてはまるものに○を付けてください。",
      notes: "",
      fields: [
        { id: "group", label: "年・組・番", enabled: true },
        { id: "name", label: "名前", enabled: true },
        { id: "date", label: "日付", enabled: false },
      ],
      questions: [
        q("scale", { title: "学校は楽しいですか", scale: ["とても楽しい", "楽しい", "あまり楽しくない", "楽しくない"] }),
        q("single", { title: "朝ごはんを毎日食べていますか", options: ["毎日食べる", "ときどき食べる", "あまり食べない"], direction: "horizontal" }),
        q("number", { title: "1日に家で勉強する時間はどのくらいですか", unit: "分くらい", width: "short" }),
        q("long", { title: "学校でがんばっていることを書いてください", lines: 4 }),
      ],
    }),
  },
  {
    id: "event",
    label: "イベント向け",
    description: "明るいオレンジで、来場者・お客様アンケートに",
    design: { fontSize: 10.5, titleSize: 20, titleAlign: "center", margin: 15, spacing: 6, answerScale: 1, headingStyle: "bar", accent: "#e8730c", numbering: true, showRequired: true, ruledLines: false },
    sample: () => ({
      title: "ご来場者アンケート",
      description: "ご来場ありがとうございます！今後のイベントづくりの参考にさせていただきます。",
      guide: "ご記入後、受付の回収箱へお入れください。",
      notes: "",
      fields: DEFAULT_FIELDS.map((f) => ({ ...f })),
      questions: [
        q("rating", { title: "イベントの満足度を星で教えてください", ratingStyle: "star", ratingLow: "不満", ratingHigh: "満足", required: true }),
        q("single", { title: "年代を教えてください", options: ["10代", "20代", "30代", "40代", "50代", "60代以上"], direction: "horizontal" }),
        q("multiple", { title: "よかった企画を選んでください（複数回答可）", options: ["ステージ", "ワークショップ", "フード", "物販"], direction: "horizontal", other: true }),
        q("long", { title: "ご感想をお聞かせください", lines: 4 }),
      ],
    }),
  },
  {
    id: "stylish",
    label: "おしゃれ",
    description: "落ち着いた色と細い線で、店舗・サロンに",
    design: { fontSize: 10, titleSize: 19, titleAlign: "center", margin: 20, spacing: 7, answerScale: 1, headingStyle: "underline", accent: "#8e5b7a", numbering: false, showRequired: false, ruledLines: true },
    sample: () => ({
      title: "お客様アンケート",
      description: "いつもご利用いただきありがとうございます。より良いサービスのため、お声をお聞かせください。",
      guide: "",
      notes: "",
      fields: [
        { id: "name", label: "お名前", enabled: true },
        { id: "group", label: "ご年代", enabled: false },
        { id: "date", label: "ご来店日", enabled: true },
      ],
      questions: [
        q("rating", { title: "本日のサービスはいかがでしたか", ratingStyle: "star", ratingLow: "", ratingHigh: "" }),
        q("multiple", { title: "当店を知ったきっかけ", options: ["Instagram", "ホームページ", "ご紹介", "通りがかり"], direction: "horizontal", other: true }),
        q("long", { title: "スタッフへのメッセージ", lines: 4 }),
      ],
    }),
  },
];

export function templateById(id: TemplateId): TemplateDef {
  return TEMPLATES.find((t) => t.id === id) ?? TEMPLATES[0];
}

/** テンプレートの見た目にする（質問の内容・用紙の向き・ページ番号はそのまま） */
export function applyTemplateDesign(design: SurveyDesign, id: TemplateId): SurveyDesign {
  return { ...design, ...templateById(id).design, template: id };
}

export function createDefaultSurvey(): Survey {
  const t = TEMPLATES[0];
  return {
    version: 1,
    title: "アンケート",
    description: "今後の参考にさせていただきますので、ご協力をお願いいたします。",
    guide: "",
    notes: "",
    fields: DEFAULT_FIELDS.map((f) => ({ ...f })),
    questions: [
      q("single", { title: "満足度を教えてください", options: ["満足", "やや満足", "やや不満", "不満"], direction: "horizontal" }),
      q("long", { title: "ご意見・ご感想をご自由にお書きください", lines: 5 }),
    ],
    design: { ...t.design, template: t.id, orientation: "portrait", pageNumbers: true },
  };
}

// ---------------------------------------------------------------------------
// 保存したデータを読むときの確認（壊れたデータ・古い形でも、画面が止まらないようにする）
// ---------------------------------------------------------------------------

const str = (v: unknown, max: number, fallback = ""): string => (typeof v === "string" ? v.slice(0, max) : fallback);
const num = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === "boolean" ? v : fallback);
const oneOf = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const TYPES: QuestionType[] = ["single", "multiple", "short", "long", "rating", "scale", "number", "date", "section"];

function sanitizeQuestion(v: unknown): Question | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const type = oneOf(o.type, TYPES, "short");
  const base = newQuestion(type);
  const list = (x: unknown, max: number) => (Array.isArray(x) ? x.slice(0, max).map((s) => str(s, LIMITS.shortText)) : null);
  return {
    id: str(o.id, 60) || base.id,
    type,
    title: str(o.title, LIMITS.text),
    description: str(o.description, LIMITS.text),
    required: bool(o.required, false),
    options: list(o.options, LIMITS.options) ?? base.options,
    other: bool(o.other, false),
    direction: oneOf(o.direction, ["vertical", "horizontal"] as const, "vertical"),
    lines: Math.round(num(o.lines, 1, LIMITS.lines, base.lines)),
    width: oneOf(o.width, ["short", "medium", "full"] as const, base.width),
    ratingMax: Math.round(num(o.ratingMax, 3, 10, 5)),
    ratingStyle: oneOf(o.ratingStyle, ["star", "number"] as const, "star"),
    ratingLow: str(o.ratingLow, LIMITS.shortText),
    ratingHigh: str(o.ratingHigh, LIMITS.shortText),
    scale: list(o.scale, LIMITS.scale) ?? base.scale,
    unit: str(o.unit, 40),
    dateStyle: oneOf(o.dateStyle, ["ymd", "wareki"] as const, "ymd"),
  };
}

export function sanitizeSurvey(v: unknown): Survey | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.version !== 1) return null;
  const def = createDefaultSurvey();
  const d = (o.design && typeof o.design === "object" ? o.design : {}) as Record<string, unknown>;
  const ids = new Set<string>();
  const questions = (Array.isArray(o.questions) ? o.questions : [])
    .slice(0, LIMITS.questions)
    .map(sanitizeQuestion)
    .filter((x): x is Question => x !== null)
    .map((x) => {
      // 重なった ID は付け直す（並べ替え・削除が正しく動くように）
      if (ids.has(x.id)) x = { ...x, id: newId() };
      ids.add(x.id);
      return x;
    });
  const fields = (Array.isArray(o.fields) ? o.fields : def.fields)
    .slice(0, LIMITS.fields)
    .map((f) => {
      const r = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
      return { id: str(r.id, 60) || newId("f"), label: str(r.label, 60), enabled: bool(r.enabled, false) };
    });
  return {
    version: 1,
    title: str(o.title, LIMITS.shortText),
    description: str(o.description, LIMITS.text),
    guide: str(o.guide, LIMITS.text),
    notes: str(o.notes, LIMITS.text),
    fields,
    questions,
    design: {
      template: oneOf(d.template, ["simple", "business", "school", "event", "stylish"] as const, def.design.template),
      orientation: oneOf(d.orientation, ["portrait", "landscape"] as const, "portrait"),
      fontSize: num(d.fontSize, 8, 16, def.design.fontSize),
      titleSize: num(d.titleSize, 12, 32, def.design.titleSize),
      titleAlign: oneOf(d.titleAlign, ["left", "center"] as const, def.design.titleAlign),
      margin: num(d.margin, 8, 30, def.design.margin),
      spacing: num(d.spacing, 2, 20, def.design.spacing),
      answerScale: num(d.answerScale, 0.6, 2, def.design.answerScale),
      headingStyle: oneOf(d.headingStyle, ["bar", "underline", "box", "plain"] as const, def.design.headingStyle),
      accent: typeof d.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(d.accent) ? d.accent : def.design.accent,
      numbering: bool(d.numbering, true),
      showRequired: bool(d.showRequired, true),
      pageNumbers: bool(d.pageNumbers, true),
      ruledLines: bool(d.ruledLines, true),
    },
  };
}
