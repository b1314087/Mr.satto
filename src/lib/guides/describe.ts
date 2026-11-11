import type { GuidePart, GuideStep } from "@/lib/guides/types";

/**
 * 「使い方」のスライドの説明文を、いま操作する部品から作る。
 * 部品の表示名は実際の画面と同じなので、説明文に出てくるボタン名・設定名も画面と同じになる。
 * 部品だけでは伝わりにくいステップは、データ側（src/lib/guides/tool-guides.ts）の desc で書く。
 */
const q = (s: string) => `「${s}」`;

function describePart(p: GuidePart): string {
  switch (p.k) {
    case "drop":
      return `${q(p.label)}の枠にファイルを置くか、${q("ファイルを選択")}を押してファイルを選びます。`;
    case "file":
      return `読み込んだファイル（${p.name} など）が並びます。必要に応じて、順番や内容を確かめます。`;
    case "seg":
    case "btns": {
      if (p.on < 0) return `${p.options.map(q).join("")}などが表示されます。`;
      const pick = p.options[p.on];
      return p.k === "seg" && p.label
        ? `${q(p.label)}で、${q(pick)}など使いたいものを選びます。`
        : `${p.options.slice(0, 3).map(q).join("")}${p.options.length > 3 ? "など" : ""}から、使いたいものを選びます。`;
    }
    case "chips":
      return `${p.label ? `${q(p.label)}で、` : ""}${p.on.map((i) => q(p.options[i])).join("")}など、使いたいものをいくつでも選べます。`;
    case "input":
      return `${q(p.label)}に入力します。`;
    case "input2":
      return `${q(p.labels[0])}と${q(p.labels[1])}を入力します。`;
    case "slider":
      return `${q(p.label)}のつまみを動かして調整します。`;
    case "check":
      return `必要に応じて、${q(p.label)}にチェックを入れます。`;
    case "select":
      return `${q(p.label)}の一覧から選びます。`;
    case "text":
      return p.label ? `${q(p.label)}の欄に、文字を入力するか貼り付けます。` : "欄に、文字を入力するか貼り付けます。";
    case "table":
      return "読み込んだ内容を表で確かめます。";
    case "head":
      return `${q(p.text)}の欄を使います。`;
    case "adv":
      return `${q(p.title)}を開くと、細かい設定を変えられます（変えなくても使えます）。`;
    case "run":
      return `設定ができたら、${q(p.label)}を押します。`;
    case "btn":
      return `${q(p.label)}を押します。`;
    case "preview":
      return "プレビューで仕上がりを確かめます。";
  }
}

export function describeStep(step: GuideStep): string {
  if (step.desc) return step.desc;
  if (step.focus === "popup") {
    return `${q("できあがりました")}と表示されたら、${q(step.popup?.label ?? "ダウンロード")}を押して保存します。`;
  }
  const part = step.parts[step.focus];
  return part ? describePart(part) : "";
}
