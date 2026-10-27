#!/usr/bin/env bash
# CIのテスト用の準備：OSのパッケージ（ブラウザ用ライブラリ・ffmpeg）と、Playwrightのブラウザを導入する。
#
# 使い方: bash scripts/ci/install-test-deps.sh（npm ci のあとに実行する）
#
# 作った理由（工程33）と、見直した理由（工程35）:
#   GitHubの実行環境では、OSのパッケージ（apt）の取得が、実行ごとに極端に遅くなることがある。
#   通常は20〜40秒で終わるが、CI #7・#9・#11・#16・#18 では、数分〜30分近くかかった。
#   - #16 では、遅いだけで最終的には成功した例があった（ffmpegの導入が約24分・約26分）。つまり「止まった」のではなく
#     「遅かった」可能性が高い。ログ本文は取得できていないので、原因（配布サーバー側の帯域など）は断定できない。
#   - 工程33では、各段階を120〜180秒で打ち切っていたため、遅いだけの実行まで失敗にしてしまった（#18）。
#   そこで、(1) 段階ごとの制限を現実的な長さにし、(2) 準備全体の予算（既定18分）を決めて、
#   ジョブ全体の30分を超えないようにし、(3) 時間切れのときだけ1回やり直し、(4) 取得が進んでいるかを定期的に表示し、
#   (5) どの段階で止まったかをログと注釈（エラー表示）に残す。
#
# 方針:
#   - やり直すのは「制限時間を超えて中断した」ときだけ。通常のエラー（パッケージが無い、設定ミス、テスト失敗など）は、
#     やり直しても変わらないので、そのまま失敗にする。
#   - やり直しでは、aptが取得済みの分を可能な範囲で引き継ぐ（取得の途中のファイルから再開できることが多い）。
#   - やり直す前に、中断したaptの残り（プロセス・半端な導入）を片付けて、少し待つ。
#   - Playwrightの「install --with-deps」は、(a) apt-get update と apt-get install、(b) ブラウザのダウンロード、の順に行う。
#     これを (a)(b) に分けて、それぞれに制限時間を付けている。導入されるものは同じ。
#   - ffmpegは、(a) の直後（apt-get update 済み）に入れる。aptの更新を二重に行わないため。
#   - 秘密情報は使わない。
#
# 時間の考え方（ジョブ全体の制限は30分）:
#   準備全体の予算 18分 ＋ 準備の前（checkout・npm ci）約1.5分 ＋ 最長のテスト（約5分）＋ 余裕 ＝ 30分以内。
#   各段階の制限は「1回あたり」で、残りの予算を超えない長さに自動で縮める。予算を使い切ったら、失敗にする。
#
# 調整用の環境変数（通常は指定しない）:
#   DEPS_TIMEOUT_SECONDS（既定300） FFMPEG_TIMEOUT_SECONDS（既定600） BROWSER_TIMEOUT_SECONDS（既定180）
#   SETUP_BUDGET_SECONDS（既定1080） RETRY_WAIT_SECONDS（既定10） PROGRESS_INTERVAL_SECONDS（既定30）

set -euo pipefail

DEPS_TIMEOUT_SECONDS="${DEPS_TIMEOUT_SECONDS:-300}"
FFMPEG_TIMEOUT_SECONDS="${FFMPEG_TIMEOUT_SECONDS:-600}"
BROWSER_TIMEOUT_SECONDS="${BROWSER_TIMEOUT_SECONDS:-180}"
SETUP_BUDGET_SECONDS="${SETUP_BUDGET_SECONDS:-1080}"
RETRY_WAIT_SECONDS="${RETRY_WAIT_SECONDS:-10}"
PROGRESS_INTERVAL_SECONDS="${PROGRESS_INTERVAL_SECONDS:-30}"
# これより短い残りでは、新しい試行を始めない
MIN_ATTEMPT_SECONDS=30
# 準備全体の期限（UNIX時間）。main で設定する。0のときは予算なし（検証用）
DEADLINE=0

# 制限時間を超えたとき、timeout コマンドが返す終了コード（124=時間切れ、137=強制終了まで必要だった）
is_timeout_code() { [ "$1" -eq 124 ] || [ "$1" -eq 137 ]; }

# 準備全体の残り時間（秒）。予算なしのときは、十分大きい値
remaining_budget() {
  if [ "$DEADLINE" -eq 0 ]; then
    echo 86400
  else
    echo $(( DEADLINE - $(date +%s) ))
  fi
}

# aptのキャッシュの大きさ（KB）。取得が進んでいるかの目安（取得の途中のファイルも含む）
apt_cache_kb() {
  sudo du -sk /var/cache/apt/archives 2>/dev/null | cut -f1 || true
}

# aptの段階の間、一定間隔で「取得が進んでいるか」を表示する（遅いのか、止まっているのかを後から判断するため）
MONITOR_PID=""
start_progress_monitor() {
  local base
  base="$(apt_cache_kb)"
  (
    local start sp kb
    start=$(date +%s)
    trap 'kill "$sp" 2>/dev/null; exit 0' TERM
    while true; do
      sleep "$PROGRESS_INTERVAL_SECONDS" &
      sp=$!
      wait "$sp"
      kb="$(apt_cache_kb)"
      echo "  [進み] 開始から$(( $(date +%s) - start ))秒: aptの取得済み +$(( ${kb:-0} - ${base:-0} )) KB"
    done
  ) &
  MONITOR_PID=$!
}
stop_progress_monitor() {
  if [ -n "$MONITOR_PID" ]; then
    kill "$MONITOR_PID" 2>/dev/null || true
    wait "$MONITOR_PID" 2>/dev/null || true
    MONITOR_PID=""
  fi
}

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
#   制限時間付きでコマンドを実行する。時間切れのときだけ、片付けて少し待ってから1回やり直す。
#   1回あたりの制限は、準備全体の残り予算を超えない長さに縮める。残りが少なければ、始めずに失敗にする。
#   timeout は、孫プロセス（apt-get など）も含めて止める。rootで動かす段階は sudo の内側で timeout を動かす
#   （一般ユーザーからは、root のプロセスを止められないため）。
run_limited() {
  local label="$1" mode="$2" limit="$3"
  shift 3
  local -a runner

  local attempt rc start elapsed remaining eff
  for attempt in 1 2; do
    remaining="$(remaining_budget)"
    if [ "$remaining" -lt 0 ]; then remaining=0; fi
    if [ "$remaining" -lt "$MIN_ATTEMPT_SECONDS" ]; then
      echo "::error title=${label}: 準備全体の時間の上限に達しました::準備全体の予算（${SETUP_BUDGET_SECONDS}秒）の残りが${remaining}秒のため、${attempt}回目を始められません。GitHub側のパッケージ取得が遅い可能性があります（コードの問題ではありません）。少し待ってから「Re-run failed jobs」で再実行してください。"
      return 124
    fi
    eff="$limit"
    if [ "$remaining" -lt "$eff" ]; then eff="$remaining"; fi

    if [ "$mode" = "root" ]; then
      runner=(sudo env "PATH=$PATH" DEBIAN_FRONTEND=noninteractive timeout -k 10 "$eff")
    else
      runner=(timeout -k 10 "$eff")
    fi

    echo "::group::${label}（${attempt}回目／最大${eff}秒、準備全体の残り${remaining}秒）"
    start=$(date +%s)
    rc=0
    if [ "$mode" = "root" ]; then start_progress_monitor; fi
    "${runner[@]}" "$@" || rc=$?
    if [ "$mode" = "root" ]; then stop_progress_monitor; fi
    elapsed=$(( $(date +%s) - start ))
    echo "::endgroup::"

    if [ "$rc" -eq 0 ]; then
      echo "${label}: 完了（${elapsed}秒）"
      return 0
    fi

    if is_timeout_code "$rc"; then
      echo "::warning title=${label}が時間切れ::${attempt}回目が${eff}秒を超えたため中断しました（終了コード ${rc}）。"
      if [ "$attempt" -eq 1 ]; then
        cleanup_after_timeout
        echo "${RETRY_WAIT_SECONDS}秒待ってから、${label}を1回だけやり直します（取得済みの分は、aptが可能な範囲で引き継ぎます）。"
        sleep "$RETRY_WAIT_SECONDS"
        continue
      fi
      echo "::error title=${label}が2回とも時間切れ::2回とも制限時間を超えました（${eff}秒）。GitHub側のパッケージ取得が遅い、または止まっている可能性があります（コードの問題ではありません）。ログの「[進み]」の行で、取得が進んでいたか確認できます。少し待ってから「Re-run failed jobs」で再実行してください。"
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
  DEADLINE=$(( total_start + SETUP_BUDGET_SECONDS ))
  echo "準備全体の予算: ${SETUP_BUDGET_SECONDS}秒（段階ごとの1回あたりの制限: ライブラリ${DEPS_TIMEOUT_SECONDS}秒／ffmpeg ${FFMPEG_TIMEOUT_SECONDS}秒／ブラウザ${BROWSER_TIMEOUT_SECONDS}秒）"

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
