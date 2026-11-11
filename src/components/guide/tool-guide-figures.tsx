import { GuideFigure } from "@/components/guide/guide-figure";
import { toolGuides } from "@/lib/guides/tool-guides";

/**
 * 「使い方」パネルの図の一覧（ツールごとに2〜4ステップ）。
 * パネルを初めて開いたときに読み込む（src/components/tools/tool-guide.tsx の import()）。
 * PC用とスマホ用の図を両方描き、どちらを見せるかは CSS（.gd-fig-pc / .gd-fig-sp）で画面の幅に合わせて切り替える。
 * 図のデータがないツールは、図を出さない（文章の手順「文章で読む」を開いた状態で見せる）。
 */
export function ToolGuideFigures({ toolId, howTo }: { toolId: string; howTo: string[] }) {
  const guide = toolGuides[toolId];
  if (!guide || guide.steps.length === 0) {
    return (
      <ol className="ms-guide-steps-text">
        {howTo.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    );
  }
  return (
    <ol className="gd-steps" data-testid="guide-figures">
      {guide.steps.map((step, i) => {
        const label = `手順${i + 1}：${step.title}`;
        return (
          <li key={i} className="gd-step" data-testid="guide-step">
            <div className="gd-fig-pc">
              <GuideFigure step={step} index={i} variant="pc" split={guide.split} title={label} />
            </div>
            <div className="gd-fig-sp">
              <GuideFigure step={step} index={i} variant="sp" split={guide.split} title={label} />
            </div>
            <p className="gd-caption">
              <span className="gd-caption-num" aria-hidden="true">
                {i + 1}
              </span>
              <span>{step.title}</span>
            </p>
          </li>
        );
      })}
    </ol>
  );
}
