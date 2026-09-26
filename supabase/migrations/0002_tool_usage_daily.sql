-- Mr.Satto Phase 11: 記入済みPDF→Excel のStandardプラン向け「1日10回まで」利用回数管理
--
-- このファイルはSupabase側で手動適用する想定（0001_billing_schema.sqlと同じ運用。
-- Supabase CLIが未接続のため、このセッションからは直接適用できない）。
-- 適用方法: Supabaseダッシュボードの SQL Editor に貼り付けて実行する。
--
-- 重要な設計方針（Phase 11 開発指示書 10-11章）:
--   - 「利用回数管理用データ」と「個人情報・ファイルデータ」を完全に分離する。
--     このテーブルにはユーザーID・ツールID・日付・回数しか持たせず、
--     PDFの中身・ファイル名・OCR結果・Excel生成結果は一切保存しない
--     （そもそもそれらはサーバーへ送信されないため、保存しようがない）。
--   - 日次リセットはクライアントのローカル時刻に依存せず、サーバー（DB）側の
--     時計を基準にする。Mr.Sattoの主な利用者は日本語話者のため、
--     UTC日付ではなく日本時間(Asia/Tokyo)の日付境界でリセットされるよう
--     usage_date を明示的にAsia/Tokyoへ変換して確定させる。
--   - 回数の加算は increment_tool_usage() 経由のみに限定する（SECURITY DEFINER）。
--     この関数は常に auth.uid() を使って「呼び出したユーザー自身の行」だけを
--     操作し、クライアントから任意のuser_idを指定させない。これにより、
--     テーブル自体へのINSERT/UPDATEポリシーを一切作らずに済み
--     （＝他ユーザーの回数を書き換える経路が構造的に存在しない）、
--     0001_billing_schema.sqlの「書き込みは限定した経路のみ」という
--     既存方針を踏襲する。
--   - このテーブルは「今回のツール専用」ではなく tool_id 列を持つ汎用的な形にし、
--     将来同種の「1日N回まで」制限を持つツールが増えても再利用できるようにする。

create table if not exists public.tool_usage_daily (
  user_id uuid not null references auth.users (id) on delete cascade,
  tool_id text not null,
  usage_date date not null,
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, tool_id, usage_date)
);

comment on table public.tool_usage_daily is
  'ユーザー×ツール×日付ごとの利用回数。個人情報・ファイルの内容は一切含まない。'
  '書き込みはincrement_tool_usage()関数経由のみ（直接のINSERT/UPDATEポリシーは作らない）。';

alter table public.tool_usage_daily enable row level security;

drop policy if exists "tool_usage_daily_select_own" on public.tool_usage_daily;
create policy "tool_usage_daily_select_own"
  on public.tool_usage_daily for select
  using (auth.uid() = user_id);

-- insert/update/deleteのポリシーは意図的に作らない。
-- 書き込みは下記のincrement_tool_usage()（SECURITY DEFINER）経由のみに限定する。

-- ============================================================
-- 当日の利用回数を取得する（読み取り専用、回数は加算しない）
-- ============================================================
create or replace function public.get_tool_usage_today(p_tool_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_count integer;
begin
  if v_user_id is null then
    -- 未ログイン（Freeユーザー）はこのテーブルの対象外。呼び出し側で
    -- 「Standardプランのログイン済みユーザーの場合のみ」呼び出す前提。
    return 0;
  end if;

  select count into v_count
  from public.tool_usage_daily
  where user_id = v_user_id and tool_id = p_tool_id and usage_date = v_today;

  return coalesce(v_count, 0);
end;
$$;

-- ============================================================
-- 当日の利用回数を1加算し、加算後の回数を返す（原子的なupsert）
-- ============================================================
create or replace function public.increment_tool_usage(p_tool_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_count integer;
begin
  if v_user_id is null then
    raise exception 'authentication required';
  end if;

  insert into public.tool_usage_daily (user_id, tool_id, usage_date, count)
  values (v_user_id, p_tool_id, v_today, 1)
  on conflict (user_id, tool_id, usage_date)
  do update set count = public.tool_usage_daily.count + 1, updated_at = now()
  returning count into v_count;

  return v_count;
end;
$$;

-- anon/authenticatedロールから直接テーブルを書き換えることはできないが、
-- SECURITY DEFINER関数の実行(EXECUTE)自体は許可する必要がある。
grant execute on function public.get_tool_usage_today(text) to authenticated;
grant execute on function public.increment_tool_usage(text) to authenticated;
