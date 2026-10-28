-- Mr.Satto 工程39: increment_tool_usage() の入力検証と、回数の上限
--
-- ★このファイルはSupabaseへ「まだ適用していません」。ユーザー自身が SQL Editor へ貼り付けて実行します
--   （0001〜0004と同じ手動適用の運用）。0002_tool_usage_daily.sql を適用済みであることが前提です。
--
-- 背景:
--   increment_tool_usage(p_tool_id text) は、ログイン済みの誰でも（ブラウザからSupabaseのAPIを直接呼んで）実行できる。
--   現状は、ツール識別子に何でも（長さ・内容とも）渡せるため、
--     - 大量の異なる識別子で行を作り、データベースの容量を使い切る
--     - 同じ識別子の回数を、際限なく増やす
--   ことができてしまう。アプリ本体は現在この関数を呼んでいない（tool_usage_daily は過去の利用制限の名残）が、
--   権限がある以上、外部から呼ばれうる。そのため、関数の中で入力を検証し、回数に安全弁の上限を設ける。
--
-- 変更点（既存の動作は、正規の入力に対して変えない）:
--   1. p_tool_id の形式を検証する: NULL・空文字・長すぎる値・許可しない文字を含む値は、エラー（22023）で拒否する。
--      許可する形式 = 小文字の英数字とハイフン、先頭は英数字、最大64文字（アプリのツール識別子 "image-resize" などと同じ形式）。
--   2. 1ユーザー・1ツール・1日あたりの回数に、安全弁の上限（1000）を設ける。上限に達したら、それ以上は増やさず、上限の値を返す
--      （エラーにはしない。呼び出し側を壊さないため）。
--      ※1000は、アプリの既知の利用制限（過去の「1日5回」）の200倍で、正規の利用では到達しない水準として置いた安全弁です。
--        業務上の制限ではありません。変更したい場合は、下の v_daily_cap の値を変えて、もう一度実行してください。
--   3. 実行権限を、ログイン済み（authenticated）だけにする（PUBLIC・anon から外す。未ログインは元々エラーになる）。
--   既存のテーブル・データは変更しない。何度流しても安全（CREATE OR REPLACE）。

begin;

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
  v_daily_cap constant integer := 1000;
begin
  if v_user_id is null then
    raise exception 'authentication required';
  end if;

  -- 入力の検証（NULL・空・長すぎる・許可しない文字は拒否）
  if p_tool_id is null or p_tool_id !~ '^[a-z0-9][a-z0-9-]{0,63}$' then
    raise exception 'invalid tool id' using errcode = '22023';
  end if;

  insert into public.tool_usage_daily (user_id, tool_id, usage_date, count)
  values (v_user_id, p_tool_id, v_today, 1)
  on conflict (user_id, tool_id, usage_date)
  do update set count = least(public.tool_usage_daily.count + 1, v_daily_cap), updated_at = now()
  returning count into v_count;

  return v_count;
end;
$$;

revoke all on function public.increment_tool_usage(text) from public, anon;
grant execute on function public.increment_tool_usage(text) to authenticated;

commit;

-- ============================================================
-- 適用後の確認（読み取りのみ）
-- ============================================================
-- (1) 関数が新しい内容になっていること（1行返り、validated = true）:
--   select (prosrc like '%invalid tool id%' and prosrc like '%v_daily_cap%') as validated
--     from pg_proc where proname = 'increment_tool_usage' and pronamespace = 'public'::regnamespace;
--
-- (2) anon / PUBLIC に実行権限が無いこと（結果が0行であること）:
--   select grantee from information_schema.routine_privileges
--    where routine_schema = 'public' and routine_name = 'increment_tool_usage' and grantee in ('anon', 'PUBLIC');
