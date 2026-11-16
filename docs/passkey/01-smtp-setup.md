# メール送信（SMTP）の準備：パスキーのメール確認と、会員登録の確認メールのために

## いまの状態（2026-11-16に確認）
- Supabase の「Authentication → Emails」に「Set up custom SMTP to edit templates」と表示 → **自前のSMTPは未設定**。
- 未設定のあいだ、Supabase 標準のメール送信は **Supabase のチームのメンバー以外には届かず、1時間に2通まで**。
- そのため、**会員登録の確認メール・パスワード再設定のメールも、一般の人には届いていない可能性が高い**（Confirm email はオン）。
  → パスキーとは別の問題。SMTPを設定すれば、会員登録・パスワード再設定・パスキーのメール確認が、まとめて解決する。

## 候補の比較（2026年11月時点。料金は変わることがあるので、登録の前に各社の料金ページで確認）
| | Resend | Brevo |
|---|---|---|
| 無料の範囲 | 月3,000通（1日100通まで） | 1日300通 |
| 有料になる条件・料金 | 1日100通・月3,000通を超える場合。Proは月20ドル（月5万通） | 1日300通を超える場合。有料プランあり |
| 一般の人への送信 | できる（ドメインの認証後） | できる（ドメインの認証と、Brevo側の送信の承認のあと） |
| ドメインの認証 | 必要（mrsatto.com のDNSに、指定のレコードを追加） | 必要（同じ） |
| Supabaseとの連携 | SMTPの設定（Host: smtp.resend.com など）を入れるだけ | SMTPの設定（Host: smtp-relay.brevo.com）を入れるだけ |
| 手間 | 少ない（承認待ちがない） | 送信の承認に数日かかることがある |

**おすすめ：Resend**（承認待ちがなく、今の規模なら無料の範囲で足りる。メールは「会員登録・パスワード再設定・新しい端末の確認コード」だけ）。

### 送るメールの量の見込み
- 確認コードは「2台目以降の新しい端末を登録するとき」だけ（端末の登録は7日間に3回まで）。会員1人あたり年に数通。
- 会員登録の確認メール・パスワード再設定のメールと、同じ枠を使う。1日100通を超え続けるまでは無料。

## 設定の手順（ご自身で行う。APIキーやパスワードはチャットに貼らない）
1. Resend（https://resend.com）でアカウントを作る（無料）。
2. Resend の「Domains」→「Add Domain」で `mrsatto.com` を追加し、表示された DNS レコード（SPF・DKIM）を、mrsatto.com を管理している場所（ドメインを買った会社、またはVercelのDNS）に追加する。Resend の画面で「Verified」になるまで待つ。
3. Resend の「API Keys」で、送信だけの権限のキーを作る（**キーはどこにも貼らず、次の手順でSupabaseに入れるだけ**）。
4. Supabase → Authentication → Emails → 「SMTP Settings」→「Enable Custom SMTP」をオンにして入力：
   - Sender email：`no-reply@mrsatto.com`　／　Sender name：`Mr.Satto`
   - Host：`smtp.resend.com`　／　Port：`465`　／　Username：`resend`　／　Password：手順3のAPIキー
   - 「Save」
5. Supabase → Authentication → Emails →「Templates」→「**Magic link or OTP**」を開き、下の文面に変えて保存（Mr.Satto はマジックリンクのログインを使っていないので、ほかの機能には影響しない）。
6. Supabase → Authentication → Sign In / Providers → Email の「Email OTP Length」が **6** になっているか確かめる（6でなければ6にする）。「Email OTP Expiration」はそのままでよい（Mr.Satto側で10分に制限している）。
7. Supabase → Authentication → Rate Limits の「Rate limit for sending emails」は、最初は既定（1時間に30通）のままでよい。

### 「Magic link or OTP」の文面
- Subject：`【Mr.Satto】確認コード`
- Body：
```html
<h2>Mr.Satto の確認コード</h2>
<p>新しい端末を登録するための確認コードです。画面に入力してください。</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:6px">{{ .Token }}</p>
<p>有効期限は10分です。このコードは、他の人に教えないでください。</p>
<p>お心当たりがない場合は、このメールを破棄し、アカウントのパスワードを変更してください。</p>
<p>Mr.Satto https://mrsatto.com</p>
```

## 設定のあとに確かめること
- ご自身以外のメールアドレス（家族のアドレスや別のGmailなど）で会員登録し、確認メールが届くか。
- パスワード再設定のメールが届くか。
