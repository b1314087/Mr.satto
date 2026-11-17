# パスキー機能を本番で公開するまでの順番

前提：コードは本番に反映済み（機能スイッチはオフ）。下の順に進める。

| 順 | 作業 | 誰が | 詳しく |
|---|---|---|---|
| 0 | Supabase の SQL Editor で `supabase/manual/passkey_launch_check.sql`（読み取りだけ）を実行し、今の状態を確かめる（0行＝まだ作られていない） | ご自身 | 下の「SQLの実行」 |
| 1 | Supabase の SQL Editor で `supabase/manual/passkey_launch.sql` を1回実行する（0011と同じ内容。何度実行しても安全）→ もう一度 `passkey_launch_check.sql` を実行して確かめる | ご自身 | 下の「SQLの実行」 |
| 2 | 既存の有料会員へ、1回目のお知らせを送る（公開の1週間ほど前） | ご自身 | 02-member-notice.md |
| 3 | 機能スイッチをオンにする変更（1行）をプッシュする（プライバシーポリシーの記載と版も、同時に新しくなる） | Claudeが用意 → ご自身がプッシュ | 下の「スイッチ」 |
| 4 | 実機で確かめる（iPhone・Mac・Android・Windows） | ご自身 | 03-device-test-guide.md |
| 5 | 2回目のお知らせ（当日） | ご自身 | 02-member-notice.md |

パスキーには、メールの確認（確認コード）を使いません。メール送信（SMTP）の設定は、パスキーの公開の条件ではありません（会員登録の確認メールの問題として、`docs/operations/email-smtp-setup.md` で別に対応）。

問題が起きたときは、スイッチをオフに戻す1行の変更をプッシュすれば、すぐ元の動き（パスキーなし）に戻る。DBの表はそのままでよい。

## SQLの実行（手順1）
1. https://supabase.com/dashboard → Mr.Satto のプロジェクト → 左のメニューの「SQL Editor」。
2. 「New query」→ `supabase/manual/passkey_launch.sql` の中身を全部貼り付ける → 右下の「Run」。
3. 正常：「Success. No rows returned」。エラーが出たら、その画面を送る（SQLの中に秘密の値はない）。
4. 確認：「New query」→ `supabase/manual/passkey_launch_check.sql` の中身を貼り付けて「Run」。19行（表6・関数13）が出て、「正常」の列がすべて true なら完了。
   false の行があったり、行が足りなかったりしたら、その画面を送る。

## スイッチ（手順3）
`src/lib/config/features.ts` の本番の設定（PRODUCTION_FLAGS）の `passkey: false` を `passkey: true` にするだけ。
あわせて `src/lib/legal/versions.ts` のプライバシーポリシーの版（passkey がオンのときの日付）を、オンにする日の日付にする。
この変更だけを、ほかの変更と分けて1つのコミットにする（問題があれば、このコミットだけを戻せるように）。
★本人の明確な許可があるまで、オンにする変更は用意・反映しない。
スイッチをオンにすると、次が同時に変わる：
- 有料会員は、パスキーの登録・本人確認をするまで、無料と同じ扱い（契約はそのまま）
- 「アカウント」に「パスキーと登録端末を管理する」が出る。`/account/security` が開ける
- プライバシーポリシーに、保存する情報の記載が出て、版がオンにした日の日付になる
