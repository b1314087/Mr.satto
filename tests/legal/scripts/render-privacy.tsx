// プライバシーポリシーのページを、環境変数を指定した状態でHTMLに書き出し、確認用の結果をJSONで出力する
// （tests/legal/privacy-adsense.spec.ts から、npx tsx で実行する）
import { renderToStaticMarkup } from "react-dom/server";
import PrivacyPage from "@/app/privacy/page";
import { LEGAL_VERSIONS } from "@/lib/legal/versions";

const html = renderToStaticMarkup(PrivacyPage());
process.stdout.write(JSON.stringify({ version: LEGAL_VERSIONS.privacy, html }));
