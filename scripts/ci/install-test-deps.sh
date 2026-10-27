#!/usr/bin/env bash
# CIのテスト用の準備：OSのパッケージ（ブラウザ用ライブラリ・ffmpeg）と、Playwrightのブラウザを導入する。
#
# 使い方: bash scripts/ci/install-test-deps.sh（npm ci のあとに実行する）
#
# 作った理由（工程33）:
#   CI #16 で、ffmpegの導入（apt-get）が20分以上かかり、3つのテストジョブが30分の制限でキャンセルされた。
#   過去の #7・#9・#11 でも同じ手順が12〜30分かかっていた。通常は20〜40秒で終わるため、
#   GitHubの実行環境がOSのパッケージ配布サーバーに接続するときの、一時的な遅延や停止と考えられる。
#   そこで、(1) 通信の待ち時間を短くし、(2) 各段階に制限時間を設け、(3) 制限時間を超えたときだけ1回やり直し、
#   (4) どの段階で止まったかをログと注釈（エラー表示）に残す。
#
# 方針:
#   - やり直すのは「制限時間を超えて中断した」ときだけ。通常のエラー（パッケージが無い、設定ミス、テスト失敗など）は、
#     やり直しても変わらないので、そのまま失敗にする。
#   - やり直す前に、中断したaptの残り（プロセス・半端な導入）を片付ける。
#   - Playwrightの「install --with-deps」は、(a) apt-get update と apt-get install、(b) ブラウザのダウンロード、の順に行う。
#     これを (a)(b) に分けて、それぞれに制限時間を付けている。導入されるものは同じ。
#   - ffmpegは、(a) の直後（apt-get update 済み）に入れる。aptの更新を二重に行わないため。
#   - 秘密情報は使わない。
#
# 調整用の環境変数（通常は指定しない）:
#   DEPS_TIMEOUT_SECONDS（既定180） FFMPEG_TIMEOUT_SECONDS（既定120） BROWSER_TIMEOUT_SECONDS（既定180）
#   それぞれ「1回あたり」の制限時間。通常は15〜40秒で終わる。

set -euo pipefail

DEPS_TIMEOUT_SECONDS="${DEPS_TIMEOUT_SECONDS:-180}"
FFMPEG_TIMEOUT_SECONDS="${FFMPEG_TIMEOUT_SECONDS:-120}"
BROWSER_TIMEOUT_SECONDS="${BROWSER_TIMEOUT_SECONDS:-180}"

# 制限時間を超えたとき、timeout コマンドが返す終了コード（124=時間切れ、137=強制終了まで必要だった）
is_timeout_code() { [ "$1" -eq 124 ] || [ "$1" -eq 137 ]; }

# 中断したaptの残りを片付ける（残っていると、やり直しがロックで失敗する）
cleanup_after_timeout() {
  echo "中断した処理の残りを確認します。"
  local i
  for i in 1 2 3 4 5; do
    if pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -x dpkg >/dev/null; then
      sleep 2
    else
      break
    fi
  done
  # 導入の途中で止まったパッケージがあれば、設定を完了させる（何も無ければ即座に終わる）
  sudo env DEBIAN_FRONTEND=noninteractive timeout -k 10 60 dpkg --configure -a || echo "dpkg --configure -a は完了しませんでした（続行します）。"
}

# run_limited <段階の名前> <root|user> <制限秒> <コマンド...>
#   制限時間付きでコマンドを実行する。時間切れのときだけ、片付けてから1回やり直す。
#   timeout は、孫プロセス（apt-get など）も含めて止める。rootで動かす段階は sudo の内側で timeout を動かす
#   （一般ユーザーからは、root のプロセスを止められないため）。
run_limited() {
  local label="$1" mode="$2" limit="$3"
  shift 3
  local -a runner
  if [ "$mode" = "root" ]; then
    runner=(sudo env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive timeout -k 10 "$limit")
  else
    runner=(timeout -k 10 "$limit")
  fi

  local attempt rc start elapsed
  for attempt in 1 2; do
    echo "::group::${label}（${attempt}回目／最大${limit}秒）"
    start=$(date +%s)
    rc=0
    "${runner[@]}" "$@" || rc=$?
    elapsed=$(( $(date +%s) - start ))
    echo "::endgroup::"

    if [ "$rc" -eq 0 ]; then
      echo "${label}: 完了（${elapsed}秒）"
      return 0
    fi

    if is_timeout_code "$rc"; then
      echo "::warning title=${label}が時間切れ::${attempt}回目が${limit}秒を超えたため中断しました（終了コード ${rc}）。"
      if [ "$attempt" -eq 1 ]; then
        cleanup_after_timeout
        echo "${label}: 1回だけやり直します。"
        continue
      fi
      echo "::error title=${label}が2回とも時間切れ::${limit}秒の制限を2回超えました。GitHub側のパッケージ配布サーバーの遅延・停止の可能性があります（コードの問題ではありません）。少し待ってから「Re-run failed jobs」で再実行してください。"
      return "$rc"
    fi

    # 時間切れ以外の失敗（パッケージが無い、設定の誤りなど）は、やり直しても変わらないので、すぐ失敗にする
    echo "::error title=${label}に失敗::終了コード ${rc}（${elapsed}秒）。時間切れではないため、やり直しません。直前のログを確認してください。"
    return "$rc"
  done
}

main() {
  # aptの通信設定（すべての apt-get に効く。Playwrightが内部で動かす apt-get にも効く）。
  #   Retries: 取得に失敗したとき、aptが自分で数回やり直す
  #   Timeout: 通信が一定時間止まったら、その接続を諦める（止まったまま待ち続けない）
  #   Lock::Timeout: ほかの apt が終わるのを少し待つ
  sudo tee /etc/apt/apt.conf.d/80-ci-network >/dev/null <<'APTCONF'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
DPkg::Lock::Timeout "120";
APTCONF

  local total_start
  total_start=$(date +%s)

  # 1. ブラウザ（Chromium）を動かすためのOSのライブラリ。内部で apt-get update と apt-get install を行う
  run_limited "ブラウザ用ライブラリの導入（apt）" root "$DEPS_TIMEOUT_SECONDS" \
    ./node_modules/.bin/playwright install-deps chromium

  # 2. ffmpeg（tests/global-setup.ts が、動画・音声のテスト用ファイルを作るために使う）。上で apt-get update 済み
  run_limited "ffmpegの導入（apt）" root "$FFMPEG_TIMEOUT_SECONDS" \
    apt-get install -y ffmpeg

  # 3. Playwrightのブラウザ本体のダウンロード（Chromiumだけ）。OSの権限は不要
  run_limited "Playwrightのブラウザのダウンロード" user "$BROWSER_TIMEOUT_SECONDS" \
    ./node_modules/.bin/playwright install chromium

  # 導入できているかの確認
  echo "::group::導入の確認"
  command -v ffmpeg >/dev/null || { echo "::error title=ffmpegが見つかりません::導入に成功と出たが、ffmpeg コマンドが見つかりません。"; exit 1; }
  ffmpeg -version | head -n 1
  # ブラウザ用ライブラリが足りないと、0以外の終了コードになる
  ./node_modules/.bin/playwright install-deps --dry-run chromium
  echo "::endgroup::"

  echo "テスト用の準備が完了しました（合計 $(( $(date +%s) - total_start ))秒）。"
}

# 直接実行されたときだけ main を動かす（検証のために、関数だけを読み込めるようにしている）
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
