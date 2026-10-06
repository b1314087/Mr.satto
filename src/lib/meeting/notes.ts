/**
 * 議事録テンプレートの生成。入力(会議名・日時・参加者・議題)から、そのまま使える
 * 議事録のひな形をテキストまたはMarkdownで作る。処理は文字列の組み立てのみ(ブラウザ内)。
 */

export type MeetingKind = "regular" | "project" | "brainstorm" | "oneonone";
export type NotesFormat = "text" | "markdown";

export interface MeetingInput {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM */
  startTime: string;
  endTime: string;
  place: string;
  facilitator: string;
  recorder: string;
  /** 参加者(「、」「,」改行区切り) */
  attendees: string;
  absentees: string;
  /** 議題(1行1件) */
  agenda: string;
  kind: MeetingKind;
  sections: MeetingSectionId[];
  /** ToDo表の空行数 */
  todoRows: number;
}

export type MeetingSectionId = "agenda" | "discussion" | "decisions" | "todos" | "next" | "notes";

export const KIND_OPTIONS: { value: MeetingKind; label: string; defaultSections: MeetingSectionId[] }[] = [
  { value: "regular", label: "定例会議", defaultSections: ["agenda", "discussion", "decisions", "todos", "next"] },
  { value: "project", label: "プロジェクト会議", defaultSections: ["agenda", "discussion", "decisions", "todos", "next", "notes"] },
  { value: "brainstorm", label: "ブレインストーミング", defaultSections: ["agenda", "discussion", "decisions", "next"] },
  { value: "oneonone", label: "1on1", defaultSections: ["agenda", "discussion", "todos", "next"] },
];

export const SECTION_LABEL: Record<MeetingSectionId, string> = {
  agenda: "議題",
  discussion: "議論の内容",
  decisions: "決定事項",
  todos: "ToDo(担当・期限)",
  next: "次回の予定",
  notes: "備考・共有事項",
};

const SECTION_ORDER: MeetingSectionId[] = ["agenda", "discussion", "decisions", "todos", "next", "notes"];

export function createDefaultMeeting(today: string): MeetingInput {
  return {
    title: "",
    date: today,
    startTime: "10:00",
    endTime: "11:00",
    place: "",
    facilitator: "",
    recorder: "",
    attendees: "",
    absentees: "",
    agenda: "",
    kind: "regular",
    sections: KIND_OPTIONS[0].defaultSections,
    todoRows: 3,
  };
}

export function splitList(raw: string): string[] {
  return raw
    .split(/[、,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** 「2026年10月6日(火)」形式。日付が不正なら入力をそのまま返す */
export function formatJapaneseDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCMonth() !== Number(m[2]) - 1) return date;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日(${WEEKDAYS[d.getUTCDay()]})`;
}

function timeRange(start: string, end: string): string {
  if (start && end) return `${start}〜${end}`;
  return start || end || "";
}

export function generateMeetingNotes(input: MeetingInput, format: NotesFormat): string {
  const md = format === "markdown";
  const h1 = (t: string) => (md ? `# ${t}` : `■ ${t}`);
  const h2 = (t: string) => (md ? `## ${t}` : `\n【${t}】`);
  const bullet = (t: string) => (md ? `- ${t}` : `・${t}`);
  const lines: string[] = [];

  const title = input.title.trim() || "会議";
  lines.push(h1(`${title} 議事録`));
  lines.push("");

  const info: [string, string][] = [
    ["日時", [formatJapaneseDate(input.date), timeRange(input.startTime, input.endTime)].filter(Boolean).join(" ")],
    ["場所", input.place.trim()],
    ["司会", input.facilitator.trim()],
    ["記録", input.recorder.trim()],
    ["出席者", splitList(input.attendees).join("、")],
    ["欠席者", splitList(input.absentees).join("、")],
  ];
  for (const [k, v] of info) {
    if (v === "" && (k === "欠席者" || k === "司会" || k === "記録")) continue;
    lines.push(md ? `- **${k}**: ${v}` : `${k}: ${v}`);
  }

  const selected = SECTION_ORDER.filter((s) => input.sections.includes(s));
  const agendaItems = input.agenda
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const id of selected) {
    lines.push(h2(SECTION_LABEL[id]));
    if (id === "agenda") {
      if (agendaItems.length === 0) lines.push(bullet(""));
      agendaItems.forEach((a, i) => lines.push(md ? `${i + 1}. ${a}` : `${i + 1}. ${a}`));
    } else if (id === "discussion") {
      if (agendaItems.length === 0) {
        lines.push(bullet(""));
      } else {
        agendaItems.forEach((a, i) => {
          lines.push(md ? `### ${i + 1}. ${a}` : `${i + 1}. ${a}`);
          lines.push(bullet(""));
          lines.push("");
        });
        if (lines[lines.length - 1] === "") lines.pop();
      }
    } else if (id === "decisions") {
      lines.push(bullet(""), bullet(""));
    } else if (id === "todos") {
      const rows = Math.max(0, Math.min(30, Math.round(input.todoRows)));
      if (md) {
        lines.push("| 内容 | 担当 | 期限 | 状況 |", "| --- | --- | --- | --- |");
        for (let i = 0; i < rows; i++) lines.push("|  |  |  |  |");
      } else {
        lines.push("内容 / 担当 / 期限");
        for (let i = 0; i < rows; i++) lines.push(`${i + 1}. (内容) / (担当) / (期限)`);
      }
    } else if (id === "next") {
      lines.push(md ? "- **日時**: " : "日時: ", md ? "- **場所**: " : "場所: ", md ? "- **議題(案)**: " : "議題(案): ");
    } else {
      lines.push(bullet(""));
    }
  }
  return lines.join("\n") + "\n";
}
