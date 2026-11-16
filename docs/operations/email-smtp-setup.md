# メール送信（SMTP）の準備：会員登録の確認メール・パスワード再設定のメールのために

※パスキーとは関係ありません（パスキーにメールの確認は使いません）。会員登録まわりのメールの問題として、別に対応します。

## いまの状態（2026-11-16に確認）
- Supabase の「Authentication → Emails」に「Set up custom SMTP to edit templates」と表示 → **自前のSMTPは未設定**。
- 未設定のあいだ、Supabase 標準のメール送信は **Supabase のチームのメンバー以外には届かず、1時間に2通まで**。
- そのため、**会員登録の確認メール・パスワード再設定のメールが、一般の人には届いていない可能性が高い**（Confirm email はオン）。

## 候補の比較（2026年11月時点。料金は変わることがあるので、登録の前に各社の料金ページで確認）
| | Resend | Brevo |
|---|---|---|
| 無料の範囲 | 月3,000通（1日100通まで） | 1日300通 |
| 有料になる条件・料金 | 1日100通・月3,000通を超える場合。Proは月20ドル（月5万通） | 1日300通を超える場合。有料プランあり |
| 一般の人への送信 | できる（ドメインの認証後） | できる（ドメインの認証と、Brevo側の送信の承認のあと） |
| ドメインの認証 | 必要（mrsatto.com のDNSに、指定のレコードを追加） | 必要（同じ） |
| Supabaseとの連携 | SMTPの設定（Host: smtp.resend.com など）を入れるだけ | SMTPの設定（Host: smtp-relay.brevo.com）を入れるだけ |
| 手間 | 少ない（承認待ちがない） | 送信の承認に数日かかることがある |

**おすすめ：Resend**（承認待ちがなく、今の規模なら無料の範囲で足りる。送るメールは「会員登録の確認・パスワード再設定」だけ）。
※外部サービスの登録・契約は、ご自身の判断で行ってください（Claudeは登録・契約をしません）。

## 設定の手順（ご自身で行う。APIキーやパスワードはチャットに貼らない）
1. Resend（https://resend.com）でアカウントを作る（無料）。
2. Resend の「Domains」→「Add Domain」で `mrsatto.com` を追加し、表示された DNS レコード（SPF・DKIM）を、mrsatto.com を管理している場所（ドメインを買った会社、またはVercelのDNS）に追加する。Resend の画面で「Verified」になるまで待つ。
3. Resend の「API Keys」で、送信だけの権限のキーを作る（**キーはどこにも貼らず、次の手順でSupabaseに入れるだけ**）。
4. Supabase → Authentication → Emails → 「SMTP Settings」→「Enable Custom SMTP」をオンにして入力：
   - Sender email：`no-reply@mrsatto.com`　／　Sender name：`Mr.Satto`
   - Host：`smtp.resend.com`　／　Port：`465`　／　Username：`resend`　／　Password：手順3のAPIキー
   - 「Save」
5. メールの文面（Templates）の「Confirm signup」「Reset password」は、今の設定のままでよい。

## 設定のあとに確かめること
- ご自身以外のメールアドレス（家族のアドレスや別のGmailなど）で会員登録し、確認メールが届くか（迷惑メールのフォルダも確認）。
- パスワード再設定のメールが届くか。
