# 外部サービスの設定確認・運用ガイド（工程40）

Mr.Sattoは、Stripe（お支払い）・Vercel（公開）・Supabase（会員・契約のデータ）・OpenAI（AI機能）の4つの外部サービスに支えられています。
このガイドは、それぞれの設定が、アプリの想定と食い違っていないかを、運営者ご自身が確認するための手順書と記録表です。

## 0. はじめに（必ずお読みください）

### このガイドの位置づけ

- このガイドは「確認の手順」を書いたものです。**作成した時点では、外部サービスの実際の設定は一つも確認できていません。** 記録表の結果欄は、すべて「未確認」です。確認して、ご自身で記入するまで「確認済み」にはなりません。
- 外部サービスのダッシュボード（管理画面）の操作、本番の設定変更、本番での課金・返金、APIキーの変更は、**運営者ご自身**が行います。Claudeは行いません。

### 守ってほしいルール

1. **APIキー・パスワード・Webhookの秘密鍵（`sk_…` `rk_…` `whsec_…` `eyJ…` で始まる長い文字列）は、チャットやメール、スクリーンショットに載せない。** 貼り付けてよいのは、ご自身のMacの`.env.local`ファイル、Vercelの環境変数の入力欄、Stripeの専用画面だけです。
2. **確認だけで済む項目は、「見るだけ」にする。** 値を書き換えるボタン（Save・Update・Delete・Roll key など）は、異常が見つかったときだけ、手順に従って押します。
3. **本番（live）で課金する確認は、最後に、ご自身が納得してから行う。** まずはテストモード（実際のお金が動かない）で確認します。
4. 異常が見つかったら、その場で慌てて直さず、「異常時の対応」の欄に従い、わからなければClaudeに、画面の状況（キーが写っていないもの）を伝えて相談してください。

### 記録表の書き方

結果欄には、次のどれかを書きます。

| 記号 | 意味 |
|---|---|
| 未確認 | まだ確認していない（初期状態。作成時点ではすべてこの状態） |
| OK | 確認して、期待する状態だった |
| 要対応 | 期待と違った。対応が必要（メモ欄に内容を書く） |
| 対象外 | この項目は使っていない（理由をメモ欄に） |

### 確認の順番（おすすめ）

1. 第1章 Supabase（SQLの適用状況・権限）
2. 第2章 Vercel（環境変数）
3. 第3章 Stripe（商品・価格・Webhook）
4. 第4章 OpenAI（利用上限）
5. 第5章 購入から解約までの動作確認（まずテストモード、最後に本番）
6. 第6章 記録表の総括

---

## 1. Supabase（会員・契約のデータ）

### 1-1. SQLの適用状況

Mr.Sattoのデータの仕組みは、`supabase/migrations/` フォルダのSQLを、運営者ご自身がSupabaseの「SQL Editor」に貼り付けて実行することで作られます（自動では適用されません）。
**適用済みかどうかは、コードからはわかりません。** 次の方法で、読み取りだけの確認をします。

#### 各SQLの役割と、未適用のときの影響

| 番号 | ファイル | 何を実現するか | 未適用のときの影響 |
|---|---|---|---|
| 0001 | `0001_billing_schema.sql` | 会員のプロフィール、契約の状態（subscriptions）、Webhookの重複処理防止の台帳 | 会員登録・ログイン後の処理、課金、契約の反映が動かない（課金の土台） |
| 0002 | `0002_tool_usage_daily.sql` | 1日の利用回数の記録（記入済みPDF→Excelの回数制限で使う） | 記入済みPDF→Excelの利用回数の確認が動かない／管理画面の利用状況が空になる |
| 0003 | `0003_ai_usage_ledger.sql` | AI利用量の台帳（請求期間ごとの上限を守る） | AI機能が使えない（利用量を記録できないため） |
| 0004 | `0004_terms_consents.sql` | 利用規約・プライバシーポリシーへの同意の記録 | **決済の前の同意確認が「準備中」で止まり、お申し込みできない**（工程38）。会員登録後の同意の記録も残らない |
| 0005 | `0005_tool_usage_validation.sql` | `increment_tool_usage`（利用回数を増やす関数）の入力検証と、1日1000回の安全弁 | アプリの動作には影響しない（アプリは現在この関数を呼んでいない）。ただし、ログイン済みの人がSupabaseのAPIを直接呼ぶと、不正な値で行を増やされる余地が残る（安全策が入っていない状態） |
| 0006 | `0006_profile_username.sql` | 会員のユーザー名 | 会員登録時のユーザー名の保存、アカウント画面・管理画面の表示が正しく動かない |
| 0007 | `0007_site_visits.sql` | 管理画面の「アクセス数」の集計（個人を特定しない） | アクセス数が記録されない（サイトの利用には影響しない） |
| 0008 | `0008_premium_grants.sql` | 管理画面からのプレミアム無料付与、3日間の無料お試し | 無料付与・無料お試しが動かない |

※適用の順番は、番号の小さいほうから。0003は適用前にSupabaseのバックアップ（Backups）の状態を確認してください（ファイル冒頭の注意書きより）。
※どのSQLも「何度実行しても安全」な書き方になっています（再実行しても既存のデータは消えません）。

#### 一度に確認する方法（読み取りだけ）

1. Supabaseのダッシュボードを開き、Mr.Sattoのプロジェクトを選ぶ。
2. 左のメニューの「SQL Editor」を開き、新しいクエリを作る。
3. 下のSQLを貼り付けて「Run」を押す。**このSQLは、調べるだけで、何も変更しません。**

```sql
select '0001 会員・契約の基本テーブル' as 項目,
  (to_regclass('public.profiles') is not null
   and to_regclass('public.subscriptions') is not null
   and to_regclass('public.stripe_webhook_events') is not null) as 適用済みの形跡
union all select '0002 1日の利用回数（記入済みPDF→Excel）',
  (to_regclass('public.tool_usage_daily') is not null
   and exists (select 1 from pg_proc where proname = 'get_tool_usage_today' and pronamespace = 'public'::regnamespace))
union all select '0003 AI利用量の台帳',
  (to_regclass('public.ai_usage_periods') is not null
   and to_regclass('public.ai_usage_requests') is not null
   and exists (select 1 from pg_proc where proname = 'ai_reserve' and pronamespace = 'public'::regnamespace)
   and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscriptions' and column_name = 'stripe_synced_at'))
union all select '0004 同意の記録',
  (to_regclass('public.terms_consents') is not null)
union all select '0005 利用回数の入力検証',
  exists (select 1 from pg_proc where proname = 'increment_tool_usage' and pronamespace = 'public'::regnamespace
          and prosrc like '%invalid tool id%' and prosrc like '%v_daily_cap%')
union all select '0006 ユーザー名',
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'username')
union all select '0007 アクセス数の集計',
  (to_regclass('public.site_visits_daily') is not null
   and to_regclass('public.site_visitor_hashes') is not null
   and exists (select 1 from pg_proc where proname = 'record_site_visit' and pronamespace = 'public'::regnamespace))
union all select '0008 無料付与・3日間お試し',
  (to_regclass('public.premium_grants') is not null
   and to_regclass('public.premium_trial_claims') is not null
   and exists (select 1 from pg_proc where proname = 'ai_derive_period' and pronamespace = 'public'::regnamespace and prosrc like '%premium_grants%'))
order by 1;
```

**期待する結果:** 8行すべてが `true`（`t`）。

- 結果に `false` がある行は、その番号のSQLが未適用（または一部だけ適用）の可能性があります。
- このSQLの判定は「形跡」の確認です。使い捨てのデータベースで、①何も適用していない状態、②0001・0002だけの状態、③0001〜0008すべての状態を作って、期待どおりの結果（①はすべて`false`、②は0001と0002だけ`true`、③はすべて`true`）になることを確認済みです。ただし、本番のSupabaseでの結果は、ご自身で実行するまでわかりません。

#### 異常時の対応（未適用のSQLがあった場合）

1. `supabase/migrations/` フォルダの、未適用の番号のファイルを開く（Macの `~/Desktop/Mr-Satto/supabase/migrations/`）。
2. ファイルの中身をすべてコピーし、SQL Editorに貼り付けて「Run」を押す。**番号の小さいものから、1つずつ。**
3. エラーが出たら、そこで止めて、エラーの文面（キーなどが含まれていないもの）をClaudeに伝える。
4. 適用後、上の確認SQLをもう一度実行して、`true` になったことを確認する。
5. 0004・0008のファイル冒頭には「コードを公開（push）する前に適用する」と書かれています。すでに公開済みで未適用の場合は、できるだけ早く適用してください（0004が未適用だと、お申し込みできません）。

#### 0004・0005の追加の確認（適用後の確認用SQL）

どちらも、ファイルの末尾に、適用後の確認用のSQLが書かれています（読み取りだけ）。

- 0004: テーブルがあり行レベルセキュリティ（RLS）が有効／ブラウザ側のロール（anon・authenticated）に権限がない／ポリシーがない／更新を拒否するトリガーがある、の4つ。
- 0005: 関数が新しい内容になっている／anon・PUBLICに実行権限がない、の2つ。

### 1-2. 権限設定の確認

| ID | 確認対象 | 確認方法 | 期待する状態 | 異常時の対応 |
|---|---|---|---|---|
| S-11 | すべてのテーブルでRLS（行レベルセキュリティ）が有効 | SQL Editorで下の「RLSの確認SQL」を実行 | 表示されたテーブルすべてが `true` | `false` のテーブルがあれば、Claudeに相談（そのテーブルのSQLを再適用する、または有効化のSQLを案内します） |
| S-12 | サービスロールキーが公開されていない | Vercelの環境変数で、`SUPABASE_SERVICE_ROLE_KEY` の名前に `NEXT_PUBLIC_` が付いていない（第2章） | 名前が `SUPABASE_SERVICE_ROLE_KEY` のみ | 付いていたら、すぐにSupabaseでそのキーを再発行（Roll）し、Vercelの値を差し替える。キーの変更はご自身で行う |
| S-13 | メールアドレスの確認（Confirm email）が有効 | Supabase「Authentication」→「Sign In / Providers」→ Email の設定で「Confirm email」がオン | オン（管理画面の管理者判定は、メール確認済みであることが条件のため） | オフなら、オンにする（変更前に、既存の会員への影響をClaudeに相談） |
| S-14 | ログイン後の戻り先URL | Supabase「Authentication」→「URL Configuration」の「Site URL」と「Redirect URLs」 | Site URLが `https://mrsatto.com`。Redirect URLsに、本番以外の不要なURLが残っていない | 不要なURLは削除する |
| S-15 | バックアップ | Supabase「Database」→「Backups」 | 自動バックアップが有効（プランにより日次など。PITR＝時点復元の有無も記録） | プランの制限は記録のみ。SQL適用（特に0003）の前には、手動で状態を確認する |

#### RLSの確認SQL（読み取りだけ）

```sql
select tablename as テーブル, rowsecurity as 行レベルセキュリティ
from pg_tables where schemaname = 'public' order by tablename;
```

使い捨てのデータベースに0001〜0008をすべて適用した状態では、11個のテーブル（`ai_usage_periods` `ai_usage_requests` `premium_grants` `premium_trial_claims` `profiles` `site_visitor_hashes` `site_visits_daily` `stripe_webhook_events` `subscriptions` `terms_consents` `tool_usage_daily`）すべてが `true` になることを確認済みです。

---

## 2. Vercel（公開サーバーの環境変数）

### 確認方法（値は見ない・書き換えない）

1. Vercelのダッシュボードで、Mr.Sattoのプロジェクトを開く。
2. 「Settings」→「Environment Variables」を開く。
3. 下の表の「名前」が、期待する環境（Production / Preview / Development）に設定されているかを、**名前と、右側の環境の表示だけ**で確認する（値は隠れていて、確認の必要もありません）。
4. 値を変えたあとは、**再デプロイしないと反映されません**（環境変数はビルド・起動時に読み込まれます）。

### 環境変数の一覧

| ID | 名前 | 種類 | 設定する環境 | 期待する状態 |
|---|---|---|---|---|
| V-01 | `NEXT_PUBLIC_SITE_URL` | 公開値 | Production | `https://mrsatto.com`（末尾の`/`なし・https）。**決済のOrigin確認と、支払い後の戻り先に使われます。** 仮の値や`http`のままだと、決済が「準備中」になります |
| V-02 | `NEXT_PUBLIC_SUPABASE_URL` | 公開値 | Production | SupabaseのプロジェクトURL |
| V-03 | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公開値 | Production | Supabaseの anon（公開用）キー。サービスロールキーと取り違えていないこと |
| V-04 | `SUPABASE_SERVICE_ROLE_KEY` | **秘密** | Production のみ | 設定されている。`NEXT_PUBLIC_`が付いていない |
| V-05 | `STRIPE_SECRET_KEY` | **秘密** | Production は本番キー（`sk_live_…`または`rk_live_…`） | 本番にテストキー（`_test_`）が入っていない。逆に、Previewに本番キーを入れない |
| V-06 | `STRIPE_WEBHOOK_SECRET` | **秘密** | Production | 本番のWebhookエンドポイント（第3章）の署名シークレット（`whsec_…`） |
| V-07 | `STRIPE_PREMIUM_PRICE_ID` | 設定値 | Production | 月額1,100円（税込・円・毎月）のPrice ID（`price_…`）。金額が違うと、アプリが決済を止めます |
| V-08 | `STRIPE_PORTAL_CONFIGURATION_ID` | 設定値 | Production | Mr.Satto専用のカスタマーポータル設定のID（`bpc_…`）。Stripeのアカウントを他のサービスと共有しているなら**必須** |
| V-09 | `STRIPE_STANDARD_PRICE_ID` | 設定値（任意） | Production | 旧Standard（550円）の契約者がいる間だけ。いなければ未設定でよい |
| V-10 | `STRIPE_PREMIUM_PRODUCT_ID` / `STRIPE_PREMIUM_LEGACY_PRICE_IDS` | 設定値（任意） | Production | 旧価格（980円など）の契約者が残っている間だけ。移行が終われば空にする |
| V-11 | `OPENAI_API_KEY` | **秘密** | **Production のみ**（Previewには設定しない） | 設定されている。Previewには無い（プレビューのたびに有料のAIを呼ばないため。コード側でもプレビューでは利用不可にしています） |
| V-12 | `ADMIN_EMAILS` | 設定値 | Production | 管理者のメールアドレス（カンマ区切り）。**そのメールアドレスのアカウントが、メール確認済みであること**が必要。未設定だと、誰も管理画面に入れません |
| V-13 | `ANALYTICS_EXCLUDED_EMAILS` | 設定値（任意） | Production | アクセス数に含めたくないアカウントがあるときだけ |
| V-14 | `TEMP_ACCESS_SECRET` | **秘密** | Production | 広告（リワード広告）を再開するときに必要な署名の鍵。広告オフの間は動作に影響しないが、設定しておくと、再開時の漏れを防げる |
| V-15 | `VISIT_HASH_SECRET` | **秘密**（任意） | Production | アクセス数の重複判定に使う鍵。未設定の場合は、`SUPABASE_SERVICE_ROLE_KEY`が代わりに使われます（動作はする）。※このキーは`.env.example`には載っていません |
| V-16 | `NEXT_PUBLIC_ADSENSE_*` / `NEXT_PUBLIC_GAM_REWARDED_AD_UNIT_PATH` | 公開値（任意） | Production | 広告をオフにしている間（コードの機能スイッチ`ads: false`）は、未設定でも設定済みでも、広告は出ない |
| V-17 | `NEXT_PUBLIC_FEATURES_OFF` | テスト用 | **どの環境にも設定しない** | 設定されていないこと（開発・テストで機能のオフを試すための値。本番には設定しません） |

補足:
- 広告・課金の「入れる／切る」は、環境変数ではなく、コード（`src/lib/config/features.ts`の`PRODUCTION_FLAGS`）で決まります。現在の設定は、課金オン・広告オフです。
- 上の表にない環境変数が設定されている場合は、用途を確認し、不要なら（ご自身の判断で）整理してください。

### 異常時の対応

- 必要な名前が無い／環境が違う → その環境にだけ追加（値はご自身で入力）。追加後に再デプロイ。
- 秘密の変数の名前に`NEXT_PUBLIC_`が付いている → 秘密が公開されている可能性があります。**すぐに**該当サービス（Stripe／Supabase／OpenAI）でキーを再発行し、正しい名前で設定し直してください。
- 値の末尾に空白や改行が混ざった疑い（貼り付けミス）→ アプリは一部で自動的に取り除きますが、貼り直すのが確実です。

---

## 3. Stripe（お支払い）

**まず、画面の左上や右上で、「テストモード（Test mode）」と「本番（Live）」のどちらを見ているかを確認してください。** 設定は、モードごとに別々です。第3章は、本番とテストの両方で行います（テストモードでの確認は、第5章の準備にもなります）。

### 3-1. 商品・価格

| ID | 確認対象 | 確認方法 | 期待する状態 | 異常時の対応 |
|---|---|---|---|---|
| T-01 | Premiumの価格 | Stripe「商品カタログ」→ Premiumの商品 → 価格 | 1,100円・円（JPY）・毎月（月次）・有効。税込として扱う設定 | 金額・周期が違う価格は、**既存の価格を編集せず**、新しい価格を作ってIDを差し替える（Stripeでは、使われた価格の金額は変更できません）。差し替えは第2章のV-07 |
| T-02 | VercelのPrice IDとの一致 | 価格の詳細ページのID（`price_…`）と、Vercelの`STRIPE_PREMIUM_PRICE_ID`の名前が設定済みであること（値は見比べず、後述の確認スクリプトで照合してもよい） | 一致している | 不一致なら、Vercelの値を正しい価格IDに差し替えて再デプロイ |
| T-03 | 旧価格・旧商品 | 商品カタログで、旧980円・旧Standard550円の価格 | 旧価格の契約者がいる間は有効のまま。いなくなったらアーカイブ（新規購入できなくする） | 旧価格に契約者がいる状態でアーカイブしない |

### 3-2. Webhook（Stripeからの契約状態の通知）

| ID | 確認対象 | 確認方法 | 期待する状態 | 異常時の対応 |
|---|---|---|---|---|
| T-11 | エンドポイントのURL | Stripe「開発者」→「Webhook」→ エンドポイント | `https://mrsatto.com/api/stripe/webhook`（本番モード）。有効 | URLが違う、またはエンドポイントが無い場合は、正しいURLで作成し、表示される署名シークレット（`whsec_…`）をVercelの`STRIPE_WEBHOOK_SECRET`に設定して再デプロイ |
| T-12 | 購読しているイベント | エンドポイントの詳細 →「リッスンするイベント」 | 次の6つを購読している: `checkout.session.completed` / `customer.subscription.created` / `customer.subscription.updated` / `customer.subscription.deleted` / `invoice.paid` / `invoice.payment_failed` | 足りないイベントを追加する |
| T-13 | 最近の配信結果 | エンドポイントの詳細 →「イベントの配信」 | 直近の配信が成功（200）している。失敗が続いていない | 失敗が続く場合は、エラーの内容（本文）をClaudeに伝える。署名シークレットの食い違いが多い原因です |
| T-14 | 署名シークレットの一致 | 本番エンドポイントの署名シークレットを、Vercelの設定に入れたものと同じにする（値はチャットに書かない） | 本番モードの`whsec_…`が、Vercel Productionに入っている | 食い違うとWebhookが400で拒否され、契約状態が反映されません。シークレットを入れ直して再デプロイ |

### 3-3. カスタマーポータル（解約・お支払い方法の変更）

| ID | 確認対象 | 確認方法 | 期待する状態 | 異常時の対応 |
|---|---|---|---|---|
| T-21 | Mr.Satto専用の設定がある | Stripe「設定」→「Billing」→「カスタマーポータル」 | Mr.Satto専用の設定が1つある。そのID（`bpc_…`）がVercelの`STRIPE_PORTAL_CONFIGURATION_ID`と同じ | 無い場合は、`scripts/create-portal-config.mjs`（ファイル先頭の手順）で作成する。他サービスの既定の設定は変更しない |
| T-22 | 解約の扱い | 専用の設定の内容 | 解約は有効。「契約期間の終了時」に解約（解約後も期間の終了までは使える）。プランの変更・顧客情報の更新は無効 | 利用規約の第5条と一致させる。違えば専用の設定を修正する |

### 3-4. 本番の設定を一括で確認するスクリプト（読み取り専用）

リポジトリには、本番のStripeの設定を、読み取りだけで一括確認するスクリプト `scripts/verify-stripe-live.mjs` があります。次を確認します: キーが本番か／Priceが1,100円・円・月次・有効か／Webhookのエンドポイントと購読イベント／ポータルの専用設定／契約の状態の件数（旧価格の契約があるか）。出力に、メールアドレス・顧客ID・キーは含まれません。

使い方（Macの「ターミナル」アプリで。1行ずつコピーして実行。入力したキーは画面に表示されません）:

1. Stripe「開発者」→「APIキー」で、**読み取り専用の制限付きキー（`rk_live_…`）**を作る。必要な権限は、すべて「読み取り」で、Prices・Products・Webhook Endpoints・Customer Portal・Subscriptions。
2. ターミナルで次を実行する。

```
cd ~/Desktop/Mr-Satto
read -s STRIPE_SECRET_KEY
```

3. ここでキーを貼り付けて Enter（何も表示されないのが正常）。続けて次を実行する（`price_xxx`は、Vercelに設定しているPrice IDに置き換える。秘密ではありません）。

```
export STRIPE_SECRET_KEY
export STRIPE_PREMIUM_PRICE_ID=price_xxx
node scripts/verify-stripe-live.mjs
unset STRIPE_SECRET_KEY
```

**期待する結果:** 各項目が `[OK]`。`[要対応]` が出た項目は、上のT-01〜T-22の該当項目に従って対応する。権限が足りない項目は「確認できず」と出ます（キーの権限を足して再実行）。

---

## 4. OpenAI（AI機能の利用上限）

AI機能（年度カレンダーの予定表の読み取り、フォームの読み取り、PowerPointの文字の判断など）は、Premiumの会員だけが使えます。アプリの側にも上限がありますが、**OpenAI側の上限を、必ず別に設定してください**（アプリの不具合やキーの漏えいがあっても、請求が際限なく増えないための、最後の安全策です）。

### アプリ側の上限（コードで決まっている値）

- 1契約者・1請求期間あたり：実コスト 3ドル（約500円）相当まで（`src/lib/ai/pricing.ts` の `AI_PERIOD_LIMIT_MICRO_USD`）。
- 3日間の無料お試し中：0.6ドルまで。
- AI呼び出しの前に、最悪ケースの金額を「予約」し、上限を超える場合は呼び出さない仕組みです（0003のSQL）。
- AI機能は、課金がオフの間・Vercelのプレビュー環境・APIキーが未設定の間は、利用不可になります。

### 確認する項目

| ID | 確認対象 | 確認方法 | 期待する状態 | 異常時の対応 |
|---|---|---|---|---|
| O-01 | 専用のプロジェクトとキー | OpenAIのダッシュボードで、Mr.Satto専用の「プロジェクト」と、そのプロジェクトのAPIキーを使っている | 他のサービスとキーを共有していない（共有していると、上限が合算され、原因の切り分けもできない） | Mr.Satto専用のプロジェクトを作り、新しいキーを発行してVercelのProductionに設定（キーの発行・差し替えはご自身で。チャットには貼らない） |
| O-02 | 月額の利用上限（ハードリミット） | OpenAI「Settings」→「Limits」（または「Billing」の利用上限・予算の項目。画面の名前は変わることがあります） | 月の上限金額が設定されている。目安：**想定するPremium会員数 × 3ドル ＋ 余裕**（例：会員30人なら、90ドルに余裕を足して、100〜120ドル程度） | 設定されていなければ、まず低めの金額で設定し、会員が増えたら見直す |
| O-03 | 通知（アラート） | 同じ設定画面の、利用額の通知（メール）の項目 | 上限の50%・80%などで、運営者のメールに通知が届く設定 | 設定する |
| O-04 | キーの権限 | プロジェクトのAPIキーの権限 | 必要な機能（モデルの呼び出し）だけの制限付きキー、または、プロジェクトを限定したキー | 広すぎる権限のキーなら、発行し直す |
| O-05 | 本番だけに設定されている | Vercelの環境変数（第2章V-11） | Productionのみ | Previewにあれば削除する |
| O-06 | 実際の利用額と、アプリの台帳の突き合わせ | OpenAIの利用状況ページの月間の合計と、Mr.Sattoの管理画面（`/admin`）のAI利用量 | 大きなずれがない（アプリの台帳は、安全側＝多めに数えるため、OpenAIの実額よりやや多くなるのが正常） | OpenAIの実額が、アプリの台帳より明らかに多い場合は、キーが他で使われている可能性があります。すぐにキーを再発行し、Claudeに相談する |

---

## 5. 購入から解約までの動作確認

この章は、「会員登録 → お申し込み → 契約の反映 → AI機能の利用 → 解約 → 期間終了後に無料に戻る」までが、正しくつながっているかを確認する手順です。

### 5-0. 確認の進め方と、注意点

**ステップAでテストモード（実際のお金が動かない）で確認し、問題がなければ、ステップBで本番の確認を行います。ステップBは、実際に1,100円を支払う操作を含むため、ご自身が納得した場合だけ行ってください。**

テストモードで確認するときの注意点（アプリの仕組みから、次のことに気をつけてください）:

1. **「Mac上で動かす確認」が、最も安全です。** Macで`npm run dev`で開発用の画面を動かし、Stripeのテストモードのキーを使います。このとき、決済のOrigin確認は`localhost`を許可します（開発中だけ。本番では許可されません）。
2. **Vercelの「プレビュー」では、そのままでは決済が拒否されます。** Origin確認は、サイトのURL設定（`NEXT_PUBLIC_SITE_URL`）だけを基準にするためです。プレビューで確認したい場合は、プレビュー環境に限って、`NEXT_PUBLIC_SITE_URL`にそのプレビューのURLを設定する必要があります（本番の設定は変えない）。
3. **テストに使うSupabaseの選択（重要）。** Macで動かす画面が、本番と同じSupabaseを指していると、テスト用の会員・契約のデータが**本番のデータベースに作られます**。次のどちらかを選んでください。
   - おすすめ：テスト用に、別のSupabaseプロジェクト（無料プランで可）を作り、0001〜0008のSQLを適用して、そのキーを`.env.local`に入れる。
   - 本番のSupabaseを使う場合：テスト用のメールアドレスで会員登録し、確認後に、アカウント画面の「アカウント削除」で消す（工程38の機能）。Stripe側のテストデータは、テストモードのため、実際の請求には影響しません。
4. `.env.local`（Macの `~/Desktop/Mr-Satto/.env.local`、Gitには入りません）に、テスト用のキー（`STRIPE_SECRET_KEY=sk_test_…`、`STRIPE_PREMIUM_PRICE_ID`＝**テストモードの**価格ID、`STRIPE_WEBHOOK_SECRET`＝後述のStripe CLIが表示するもの）を書く。**キーは、チャットに貼らない。**
5. テストモードにも、1,100円・円・月次の価格を、別に作る必要があります（モードごとに商品・価格は別のため）。アプリは、決済の前に価格の中身を照合し、違えば決済を止めます。
6. テストのWebhookは、Stripe CLIで受けます（Macのターミナル）。
   ```
   brew install stripe/stripe-cli/stripe
   stripe login
   stripe listen --forward-to localhost:3000/api/stripe/webhook
   ```
   `stripe listen`が表示する `whsec_…` を、`.env.local` の `STRIPE_WEBHOOK_SECRET` に入れ、開発用の画面を起動し直す。
7. テストモードでは、本物のカードを使いません。Stripe公式のテスト用カード番号（`4242 4242 4242 4242`、有効期限は未来の日付、CVCは任意の3桁）を使います（ほかのテスト用カードは、Stripe公式ドキュメントの「テスト用カード」の一覧で確認してください）。

### 5-1. ステップA：テストモードでの確認

| ID | 確認する動作 | 手順 | 期待する状態 | 異常時の対応 |
|---|---|---|---|---|
| P-01 | 会員登録 | テスト用のメールアドレスで会員登録 → 届いた確認メールのリンクを開く | 登録できる。同意のチェックが必須。確認後にログインできる | 同意の記録（0004）がないと次のP-03で止まる。メールが届かない場合は、Supabaseのメール設定を確認 |
| P-02 | 料金ページ | `/pricing`を開く | プレミアム月額1,100円（税込）の案内。「プレミアムを始める」ボタン | 表示が違う場合は、Claudeに画面を伝える |
| P-03 | 決済ページへ進む | ログインした状態で「プレミアムを始める」を押す | Stripeの決済ページ（テストモード）に移動する。金額は1,100円 | 「準備中」と出る場合：価格の照合の失敗（T-01）、サイトURLの設定（V-01）、同意の記録（0004）などが原因。ターミナルのログに理由が出ます |
| P-04 | 連打しても二重にならない | P-03の「プレミアムを始める」を、素早く3〜5回押す（または2つのタブで同時に押す） | 決済ページは1つだけ作られる（Stripeダッシュボードの「決済」→「Checkoutセッション」で、同じ人の未完了のセッションが1つ） | 複数できていたら、Claudeに伝える |
| P-05 | 支払いの完了 | テスト用カード`4242…`で支払う | 支払い完了後、`/account?checkout=success`に戻る | 戻り先が本番のURLになる場合は、`NEXT_PUBLIC_SITE_URL`の設定を確認 |
| P-06 | 契約の反映（Webhook） | `/account`を開く | プレミアムの契約中と表示される（Webhookが届くまで数秒かかることがある）。Stripe CLIの画面で、各イベントに`200`が表示される | 反映されない場合：Webhookの署名シークレット（T-14）、0001のテーブル、Supabaseのサービスロールキーを確認 |
| P-07 | 二重契約の防止 | 契約中の状態で、`/pricing`のボタンをもう一度押す | 「すでにご契約があります」と表示され、決済ページに進まない | 進んでしまう場合は、すぐにClaudeに伝える（重大） |
| P-08 | AI機能 | 年度カレンダーなどのAI機能を試す（テスト用のキーでは、OpenAIの実費がかかる点に注意。**ご自身が許可した場合だけ**1回試す） | 利用できる／利用量の表示が増える | 使えない場合：OpenAIのキー（V-11）、0003のSQL |
| P-09 | お支払い方法の管理画面 | `/account`の「お支払い方法の変更・解約」を押す | Stripeのカスタマーポータルが開く。Mr.Satto専用の設定（プラン変更の項目がなく、解約の項目がある） | 他サービスの設定が出る場合は、T-21 |
| P-10 | 解約 | ポータルで解約する | 「契約期間の終了時」に解約されると表示される。`/account`に、解約予定の旨と、使える期限が表示される。期限までは、引き続きプレミアム | 即時に解約・無料に戻る場合は、T-22を確認 |
| P-11 | 期間終了後 | Stripeのテストクロック（時間を進める機能）で期間終了まで進める | 契約が終了し、`/account`が無料プランに戻る。AI機能が使えなくなる | テストクロックの使い方がわからない場合は、Claudeに相談（この項目は、省略して、ステップBの本物の期間終了で確認する方法もあります） |
| P-12 | お支払いの失敗 | 別のテスト用アカウントで、支払いが失敗するテスト用カード（Stripe公式の一覧を参照）を使う | 契約が有効にならない／更新の失敗が、`/account`の表示に反映される | 想定外の挙動は、Claudeに伝える |
| P-13 | アカウント削除（契約中は不可） | 契約中のアカウントで、アカウント削除を試す（工程38） | 契約が続いている間は、削除できない（案内が出る） | 削除できてしまう場合は、重大。Claudeに伝える |
| P-14 | テストデータの片付け | テスト用の会員を、アカウント画面から削除（解約後）／Stripeのテストモードのデータは、そのままでよい（実際の請求はありません） | 不要なテスト用データが、本番のSupabaseに残っていない | 残っていれば、Supabaseの「Authentication」→「Users」で、テスト用のユーザーを削除（ご自身で） |

### 5-2. ステップB：本番での確認（ご自身が、納得した場合だけ）

**注意：このステップは、実際にお金が動きます。Claudeは行いません。ご自身の判断・ご自身のカード・ご自身の操作で行ってください。** やらない選択（ステップAと、第3章のスクリプトだけで運用を始める）もあります。

| ID | 確認する動作 | 手順 | 期待する状態 | 異常時の対応 |
|---|---|---|---|---|
| P-21 | 本番の設定の事前確認 | 第1〜4章がすべてOKであることを、記録表で確認する | すべてOK | 要対応が残っているなら、先に直す |
| P-22 | 本番での購入 | 本番サイト（`https://mrsatto.com`）で、ご自身のアカウント・ご自身のカードで、プレミアムを申し込む（1,100円） | 決済ページ→支払い→`/account`に戻り、契約中と表示される。Stripe（本番モード）のダッシュボードの「Webhook」で、直近の配信が200 | 失敗したら、すぐにStripe本番ダッシュボードで状況を確認し、Claudeに（キーを含まない形で）伝える |
| P-23 | 本番でのAI機能・領収書 | AI機能を1回試す／Stripeから届く領収書のメール | AI機能が使える／領収書が届く | 領収書のメールが届かない場合は、Stripeの「設定」→「メール」を確認 |
| P-24 | 本番での解約 | `/account`の「お支払い方法の変更・解約」から解約する | 期間終了時の解約と表示される | 想定と違う場合は、T-22 |
| P-25 | 返金（任意） | 確認のためのお支払いを返金したい場合は、**ご自身で**、Stripe本番ダッシュボードの「決済」から、該当の決済を開き「返金」を行う | 返金が記録される | 返金の操作は、Claudeは行いません |
| P-26 | 期間終了後 | 契約期間が終わった後に、`/account`を確認する | 無料プランに戻る。AI機能が使えなくなる | 戻らない場合は、Webhook（T-13）を確認 |

---

## 6. 記録表（総括）

ご自身が確認した結果を、結果欄に書き込んでください。**作成時点（2026年10月30日）では、すべて「未確認」です。** 確認済みの項目だけ、確認日と結果を更新します。

### 6-1. 先に確認する：SQLの適用状況

| ID | 確認対象 | 確認日 | 結果 | 確認した人 | メモ |
|---|---|---|---|---|---|
| S-01 | 0001（会員・契約の基本テーブル） | | 未確認 | | |
| S-02 | 0002（1日の利用回数） | | 未確認 | | |
| S-03 | 0003（AI利用量の台帳） | | 未確認 | | |
| S-04 | 0004（同意の記録）← 未適用だとお申し込みできない | | 未確認 | | |
| S-05 | 0005（利用回数の入力検証） | | 未確認 | | |
| S-06 | 0006（ユーザー名） | | 未確認 | | |
| S-07 | 0007（アクセス数の集計） | | 未確認 | | |
| S-08 | 0008（無料付与・お試し） | | 未確認 | | |

### 6-2. Supabase（権限）

| ID | 確認対象 | 確認日 | 結果 | 確認した人 | メモ |
|---|---|---|---|---|---|
| S-11 | 全テーブルでRLSが有効 | | 未確認 | | |
| S-12 | サービスロールキーが公開されていない | | 未確認 | | |
| S-13 | メールアドレスの確認（Confirm email）が有効 | | 未確認 | | |
| S-14 | Site URL・Redirect URLs | | 未確認 | | |
| S-15 | バックアップの状態 | | 未確認 | | |

### 6-3. Vercel（環境変数）

| ID | 確認対象 | 確認日 | 結果 | 確認した人 | メモ |
|---|---|---|---|---|---|
| V-01 | `NEXT_PUBLIC_SITE_URL` | | 未確認 | | |
| V-02 | `NEXT_PUBLIC_SUPABASE_URL` | | 未確認 | | |
| V-03 | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | | 未確認 | | |
| V-04 | `SUPABASE_SERVICE_ROLE_KEY` | | 未確認 | | |
| V-05 | `STRIPE_SECRET_KEY`（本番キー） | | 未確認 | | |
| V-06 | `STRIPE_WEBHOOK_SECRET` | | 未確認 | | |
| V-07 | `STRIPE_PREMIUM_PRICE_ID` | | 未確認 | | |
| V-08 | `STRIPE_PORTAL_CONFIGURATION_ID` | | 未確認 | | |
| V-09 | `STRIPE_STANDARD_PRICE_ID`（任意） | | 未確認 | | |
| V-10 | `STRIPE_PREMIUM_PRODUCT_ID` / `STRIPE_PREMIUM_LEGACY_PRICE_IDS`（任意） | | 未確認 | | |
| V-11 | `OPENAI_API_KEY`（Productionのみ） | | 未確認 | | |
| V-12 | `ADMIN_EMAILS` | | 未確認 | | |
| V-13 | `ANALYTICS_EXCLUDED_EMAILS`（任意） | | 未確認 | | |
| V-14 | `TEMP_ACCESS_SECRET` | | 未確認 | | |
| V-15 | `VISIT_HASH_SECRET`（任意） | | 未確認 | | |
| V-16 | 広告の設定（広告オフの間） | | 未確認 | | |
| V-17 | `NEXT_PUBLIC_FEATURES_OFF`が無い | | 未確認 | | |

### 6-4. Stripe

| ID | 確認対象 | 確認日 | 結果 | 確認した人 | メモ |
|---|---|---|---|---|---|
| T-01 | Premiumの価格（1,100円・月次・有効） | | 未確認 | | |
| T-02 | VercelのPrice IDとの一致 | | 未確認 | | |
| T-03 | 旧価格・旧商品の扱い | | 未確認 | | |
| T-11 | Webhookのエンドポイントのアドレス | | 未確認 | | |
| T-12 | 購読イベント（6つ） | | 未確認 | | |
| T-13 | 直近の配信結果 | | 未確認 | | |
| T-14 | 署名シークレットの一致 | | 未確認 | | |
| T-21 | Mr.Satto専用のポータル設定 | | 未確認 | | |
| T-22 | 解約の扱い（期間終了時） | | 未確認 | | |
| T-31 | `verify-stripe-live.mjs`の実行結果 | | 未確認 | | |

### 6-5. OpenAI

| ID | 確認対象 | 確認日 | 結果 | 確認した人 | メモ |
|---|---|---|---|---|---|
| O-01 | 専用のプロジェクトとキー | | 未確認 | | |
| O-02 | 月額の利用上限 | | 未確認 | | |
| O-03 | 利用額の通知 | | 未確認 | | |
| O-04 | キーの権限 | | 未確認 | | |
| O-05 | 本番だけに設定されている | | 未確認 | | |
| O-06 | 実際の利用額と台帳の突き合わせ | | 未確認 | | |

### 6-6. 購入から解約までの動作確認

| ID | 確認する動作 | 確認日 | 結果 | 確認した人 | メモ |
|---|---|---|---|---|---|
| P-01 | 会員登録（テストモード） | | 未確認 | | |
| P-02 | 料金ページ | | 未確認 | | |
| P-03 | 決済ページへ進む | | 未確認 | | |
| P-04 | 連打しても二重にならない | | 未確認 | | |
| P-05 | 支払いの完了 | | 未確認 | | |
| P-06 | 契約の反映（Webhook） | | 未確認 | | |
| P-07 | 二重契約の防止 | | 未確認 | | |
| P-08 | AI機能 | | 未確認 | | |
| P-09 | お支払い方法の管理画面 | | 未確認 | | |
| P-10 | 解約（期間終了時） | | 未確認 | | |
| P-11 | 期間終了後に無料へ戻る | | 未確認 | | |
| P-12 | お支払いの失敗 | | 未確認 | | |
| P-13 | アカウント削除（契約中は不可） | | 未確認 | | |
| P-14 | テストデータの片付け | | 未確認 | | |
| P-21 | 本番の事前確認（第1〜4章がOK） | | 未確認 | | |
| P-22 | 本番での購入 | | 未確認 | | |
| P-23 | 本番でのAI機能・領収書 | | 未確認 | | |
| P-24 | 本番での解約 | | 未確認 | | |
| P-25 | 返金（任意） | | 未確認 | | |
| P-26 | 期間終了後 | | 未確認 | | |

### 6-7. 総括

| 項目 | 記入欄 |
|---|---|
| 要対応の項目数 | |
| 対応が終わっていない項目（IDとメモ） | |
| 工程40の確認を完了とする日 | |
| 完了の判断をした人 | |

工程40の確認の完了の目安: 6-1〜6-5の項目がすべて「OK」または「対象外（理由つき）」で、5-1（テストモード）のP-01〜P-13が「OK」。5-2（本番での購入）は、ご自身が行うと決めた場合だけ。

---

## 7. 参考：関連するファイル

| 内容 | ファイル |
|---|---|
| データベースのSQL | `supabase/migrations/0001〜0008_*.sql` |
| 環境変数の一覧と説明 | `.env.example` |
| 広告・課金の機能スイッチ | `src/lib/config/features.ts` |
| Stripeの設定の読み込み | `src/lib/stripe/config.ts` |
| 決済ページの作成（二重作成の防止） | `src/app/api/stripe/checkout/route.ts` `src/lib/stripe/checkout-flow.ts` |
| Webhookの処理 | `src/app/api/stripe/webhook/route.ts` |
| Origin確認 | `src/lib/security/origin.ts` |
| 管理者の判定 | `src/lib/admin/access.ts` `src/lib/admin/auth.ts` |
| AI利用量の上限 | `src/lib/ai/pricing.ts` |
| 本番のStripe設定の確認スクリプト | `scripts/verify-stripe-live.mjs` |
| ポータル設定の作成スクリプト | `scripts/create-portal-config.mjs` |
| 個人情報に関するご請求の対応手順 | `docs/operations/personal-data-requests.md` |
