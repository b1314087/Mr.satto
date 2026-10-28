import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "アカウントを削除しました",
  robots: { index: false, follow: false },
};

export default function AccountDeletedPage() {
  return (
    <div className="mx-auto w-full max-w-sm px-4 py-16 text-center sm:px-6">
      <h1 className="mb-3 text-2xl font-bold text-ms-text">アカウントを削除しました</h1>
      <p className="mb-6 text-sm text-ms-muted">
        ご利用ありがとうございました。無料のツールは、これまでどおり、ログインなしでお使いいただけます。
      </p>
      <Link href="/" className="ms-btn ms-btn-primary">
        トップページへ
      </Link>
    </div>
  );
}
