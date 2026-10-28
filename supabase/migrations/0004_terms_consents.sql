-- Mr.Satto 工程38: 利用規約・プライバシーポリシーへの同意記録（サーバー側）
--
-- ★このファイルはSupabaseへ「まだ適用していません」。ユーザー自身が SQL Editor へ貼り付けて実行します
--   （0001〜0003と同じ手動適用の運用）。適用は、コードを本番へ公開（push）する「前」に行ってください。
--   適用前の準備・適用後の確認は、工程38の報告書（C. DB変更）を参照してください。
--
-- 目的:
--   会員登録時（および、アカウント画面での同意）に、ユーザーが同意した「文書の種類・版・日時」を
--   サーバー側に記録する。決済（Checkout）の前に、現行の版への同意が記録されていることを確認する。
--
-- 設計方針:
--   1. 記録するのは「ユーザーの識別子・文書の種類・版・同意日時・同意の経路」だけ。
--      メールアドレス、IPアドレス、端末情報など、目的に不要な個人情報は追加で集めない。
--   2. 書き込み・読み取りは、サーバー（Service Role）専用。ブラウザ側（anon/authenticated）からは、
--      テーブルに一切触れない（RLS有効＋ポリシー無し＋権限REVOKE）。クライアントが同意記録を作る・書き換える経路を作らない。
--   3. 追記専用: 行の更新（UPDATE）はトリガーで拒否する。同じ文書・同じ版の同意は、1ユーザーにつき1行だけ（重複はinsertしない）。
--   4. アカウントを削除すると、このテーブルの行も連鎖して削除される（auth.users への外部キー on delete cascade）。
--      ※同意記録を、アカウント削除後も一定期間残すかどうかは、運営者の判断（法的確認）が必要な事項です。
--        現在は「残さない」設計です。残す場合は、この外部キーを変更する別のSQLが必要になります。
--   5. 既存のテーブル・データは変更しない。何度流しても安全（IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS）。
--
-- 版（version）の値:
--   アプリ側の src/lib/legal/versions.ts の値（例: '2026-10-28'）。規約を改定するたびに、この値を更新する。

begin;

create table if not exists public.terms_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  document text not null check (document in ('terms', 'privacy')),
  version text not null check (length(version) between 1 and 32),
  source text not null check (source in ('signup', 'account')),
  accepted_at timestamptz not null default now(),
  unique (user_id, document, version)
);

comment on table public.terms_consents is
  '利用規約・プライバシーポリシーへの同意の記録（ユーザー×文書×版ごとに1行・追記専用）。'
  '保存するのは識別子・文書の種類・版・日時・経路のみ。書き込み・読み取りはService Role（サーバー）のみ。';

alter table public.terms_consents enable row level security;
-- ポリシーは意図的に作らない（anon/authenticatedは参照も変更も不可。Service Roleのみ）。

-- Supabaseは public スキーマの新規オブジェクトへ anon/authenticated の権限を既定で付与するため、明示的に剥奪する。
revoke all on table public.terms_consents from public, anon, authenticated;

-- 追記専用: UPDATE は拒否する（DELETE は、アカウント削除による連鎖削除のために許可する）。
create or replace function public.terms_consents_block_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'terms_consents is append-only';
end;
$$;

drop trigger if exists terms_consents_no_update on public.terms_consents;
create trigger terms_consents_no_update
  before update on public.terms_consents
  for each row execute function public.terms_consents_block_update();

commit;

-- ============================================================
-- 適用後の確認（読み取りのみ。SQL Editorで1つずつ実行して結果を確認）
-- ============================================================
-- (1) テーブルがあり、RLSが有効（rowsecurity = true）であること:
--   select tablename, rowsecurity from pg_tables where schemaname = 'public' and tablename = 'terms_consents';
--
-- (2) ブラウザ側のロール（anon / authenticated）に、このテーブルの権限が無いこと（結果が0行であること）:
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'terms_consents' and grantee in ('anon', 'authenticated');
--
-- (3) ポリシーが1件も無いこと（結果が0行であること）:
--   select policyname from pg_policies where schemaname = 'public' and tablename = 'terms_consents';
--
-- (4) 更新を拒否するトリガーがあること（1行返ること）:
--   select tgname from pg_trigger where tgrelid = 'public.terms_consents'::regclass and not tgisinternal;
