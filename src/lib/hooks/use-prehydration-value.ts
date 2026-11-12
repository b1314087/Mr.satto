import { useEffect, type RefObject } from "react";

/**
 * 画面の準備（ハイドレーション）が終わる前に入力された文字を、状態に取り込む。
 *
 * ページを開いた直後、画面の部品が動き出す前に入力欄へ文字を入れると、入力欄には文字が見えているのに、
 * 内部の状態は初期値のまま、という食い違いが起きることがある（見えている文字と、作られる内容が違ってしまう）。
 * 部品が動き出したときに一度だけ、入力欄に見えている値と状態を比べ、違えば見えている値に合わせる。
 */
export function usePrehydrationValue(
  ref: RefObject<HTMLInputElement | HTMLTextAreaElement | null>,
  value: string,
  setValue: (v: string) => void
): void {
  useEffect(() => {
    const el = ref.current;
    if (el && el.value !== value) setValue(el.value);
    // 動き出したときの1回だけ（その後の入力は onChange で受け取る）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
