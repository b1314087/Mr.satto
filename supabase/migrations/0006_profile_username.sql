-- Mr.Satto: 会員のユーザー名（profiles.username）
--
-- このファイルはSupabase側で手動適用する想定（0001〜0005と同じ運用）。
-- 適用方法: Supabaseダッシュボードの SQL Editor に貼り付けて実行する。何度実行しても安全（再実行できる）。
--
-- 方針:
--   - ユーザー名は公開しない。本人のアカウント画面と、運営者の管理画面（Service Role経由）だけで読む。
--   - 3〜20文字。文字の種類の検査はアプリ側（src/lib/auth/username.ts）で行い、DBは長さと重複だけを守る。
--   - 重複は大文字・小文字を区別せず禁止する（lower(username) の一意インデックス）。
--   - 既存の会員は NULL（未設定）のまま。アカウント画面で、後から設定してもらう。
--   - 登録時にユーザー名が重複していても（ほぼ同時の登録など）、会員登録そのものは失敗させない
--     （ユーザー名だけ未設定にして登録し、アカウント画面で設定してもらう）。

alter table public.profiles add column if not exists username text;

alter table public.profiles drop constraint if exists profiles_username_length;
alter table public.profiles
  add constraint profiles_username_length
  check (username is null or char_length(username) between 3 and 20);

create unique index if not exists profiles_username_lower_key
  on public.profiles (lower(username))
  where username is not null;

comment on column public.profiles.username is
  '会員が登録時に付けるユーザー名（非公開）。3〜20文字。大文字小文字を区別せず重複不可。未設定の会員はNULL。';

-- 新規ユーザー登録時に、profilesへ1行作成する（登録時に渡されたユーザー名も保存する）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');
begin
  if v_username is not null and char_length(v_username) not between 3 and 20 then
    v_username := null;
  end if;
  begin
    insert into public.profiles (id, email, username)
    values (new.id, new.email, v_username)
    on conflict (id) do nothing;
  exception when unique_violation then
    -- ユーザー名が、ほぼ同時の別の登録と重なった: ユーザー名なしで登録する
    insert into public.profiles (id, email)
    values (new.id, new.email)
    on conflict (id) do nothing;
  end;
  return new;
end;
$$;
