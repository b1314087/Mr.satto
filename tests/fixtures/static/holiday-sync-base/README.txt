祝日データの自動更新（scripts/holidays）のテスト用の「更新前の基準データ」（2026-10時点: 2000〜2027年）。
このフォルダのファイルは、自動更新では書き換わらない（書き換わるのは tests/fixtures/static/cao-syukujitsu-decoded.csv など本体側）。
テスト（tests/calendar/holidays-sync.spec.ts）が「2028年分が公表されたら」などの場面を、いつでも同じ前提で試せるようにするためのもの。
