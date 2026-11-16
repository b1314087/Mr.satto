# パスキー機能を本番で公開するまでの順番

前提：コードは本番に反映済み（機能スイッチはオフ）。下の順に進め、最後にスイッチをオンにする。

| 順 | 作業 | 誰が | 詳しく |
|---|---|---|---|
| 1 | メール送信（SMTP）を設定する（会員登録の確認メールの問題も同時に解決） | ご自身 | 01-smtp-setup.md |
| 2 | ご自身以外のメールアドレスで、会員登録の確認メール・パスワード再設定のメールが届くか確かめる | ご自身 | 01-smtp-setup.md の最後 |
| 3 | Supabase の SQL Editor で `supabase/manual/passkey_launch.sql` を1回実行する（0011＋0012をまとめたもの。何度実行しても安全） | ご自身 | 下の「SQLの実行」 |
| 4 | 既存の有料会員へ、1回目のお知らせを送る（公開の1週間ほど前） | ご自身 | 02-member-notice.md |
| 5 | 機能スイッチをオンにする変更（1行）をプッシュする（プライバシーポリシーの記載と版も、同時に新しくなる） | Claudeが用意 → ご自身がプッシュ | 下の「スイッチ」 |
| 6 | 実機で確かめる（iPhone・Mac・Android・Windows） | ご自身 | 03-device-test-guide.md |
| 7 | 2回目のお知らせ（当日） | ご自身 | 02-member-notice.md |

問題が起きたときは、スイッチをオフに戻す1行の変更をプッシュすれば、すぐ元の動き（パスキーなし）に戻る。DBの表はそのままでよい。

## SQLの実行（手順3）
1. https://supabase.com/dashboard → Mr.Satto のプロジェクト → 左のメニューの「SQL Editor」。
2. 「New query」→ `supabase/manual/passkey_launch.sql` の中身を全部貼り付ける → 右下の「Run」。
3. 正常：「Success. No rows returned」。エラーが出たら、その画面を送る（SQLの中に秘密の値はない）。
4. 確認：左のメニューの「Table Editor」に、`passkey_credentials`・`registered_devices`・`passkey_challenges`・`passkey_verifications`・`paid_session_leases`・`auth_security_events`・`passkey_email_challenges` の7つの表がある。

## スイッチ（手順5）
`src/lib/config/features.ts` の本番の設定（PRODUCTION_FLAGS）の `passkey: false` を `passkey: true` にするだけ。
この1行だけを、ほかの変更と分けて1つのコミットにする（問題があれば、このコミットだけを戻せるように）。
スイッチをオンにすると、次が同時に変わる：
- 有料会員は、パスキーの登録・本人確認をするまで、無料と同じ扱い（契約はそのまま）
- 「アカウント」に「パスキーと登録端末を管理する」が出る。`/account/security` が開ける
- プライバシーポリシーに、保存する情報の記載が出て、版が 2026年11月16日 になる
