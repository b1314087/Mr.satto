import Link from "next/link";
import { featureFlags } from "@/lib/config/features";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 px-4 py-24 text-center">
      <span className="text-5xl" aria-hidden="true">
        🔍
      </span>
      <h1 className="text-xl font-bold text-ms-text">
        ページが見つかりませんでした
      </h1>
      <p className="text-sm text-ms-muted">
        お探しのツールまたはページは存在しないか、移動した可能性があります。
      </p>
      <Link
        href="/tools"
        className="ms-btn ms-btn-primary"
      >
        ツール一覧へ戻る
      </Link>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-ms-accent dark:text-ms-focus">
        <Link href="/" className="hover:underline">
          トップページ
        </Link>
        {featureFlags.billing && (
          <Link href="/pricing" className="hover:underline">
            料金プラン
          </Link>
        )}
      </div>
    </div>
  );
}
