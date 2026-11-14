-- Mr.Satto: 広告が出ないときの救済（1人につき1日1回・日本時間）の記録
--
-- ★このファイルはSupabaseへ「まだ適用していません」。ユーザー自身が SQL Editor へ貼り付けて実行します
--   （0001〜0008と同じ手動適用の運用）。何度実行しても安全（再実行できる）。
--   適用しなくてもサイトは動きます（その間は、署名付きCookieだけで同じブラウザを1日1回にします）。
--
-- 方針（個人を特定しない・最小限）:
--   - 保存するのは「日付」と「その日だけ有効な、元に戻せない識別値（ハッシュ）」だけ。
--     ハッシュは、サーバーだけが持つ秘密の値で、日付＋（ログイン中はユーザーID／未ログインは接続元とブラウザの情報）から作る。
--     日付を混ぜるので、日をまたいで同じ人を追跡できない。IPアドレス・ブラウザの情報・ユーザーIDそのものは保存しない。
--   - ファイル・ファイルの内容・ファイル名は、一切受け取らない（そもそもサーバーへ送られない）。
--   - 同じ日・同じ識別値の行は1つしか作れない（主キー）。連打・複数タブで同時に実行しても、1回しか「はじめて」にならない。
--   - 前日より古い行は、記録のたびに削除する（長く残さない）。
--   - 表と関数は、Service Role（サーバー）だけが使える（RLSを有効にし、ポリシーは作らない）。

create table if not exists public.ad_fallback_daily (
  claim_date date not null,
  claimant_hash text not null,
  created_at timestamptz not null default now(),
  primary key (claim_date, claimant_hash)
);

comment on table public.ad_fallback_daily is
  '広告が出ないときの救済（1日1回）の記録。その日だけ有効な、元に戻せない識別値だけを持つ。日付は日本時間。';

alter table public.ad_fallback_daily enable row level security;
-- ポリシーは意図的に作らない（anon / authenticated からは、読み書きとも一切できない。Service Roleは常に操作できる）。
revoke all on public.ad_fallback_daily from anon, authenticated;

-- 今日の救済を記録する。今回はじめて記録できたら true、今日すでに記録があれば false。
create or replace function public.claim_ad_fallback(p_claimant_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_rows integer;
begin
  if p_claimant_hash is null or p_claimant_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid claimant' using errcode = '22023';
  end if;

  insert into public.ad_fallback_daily (claim_date, claimant_hash)
  values (v_today, p_claimant_hash)
  on conflict do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    delete from public.ad_fallback_daily where claim_date < v_today - 1;
  end if;

  return v_rows = 1;
end;
$$;

revoke all on function public.claim_ad_fallback(text) from public, anon, authenticated;
grant execute on function public.claim_ad_fallback(text) to service_role;
