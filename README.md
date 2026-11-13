# 認証済みフォロワー チェッカー（ベータ）

X でログインすると、自分の認証済みフォロワーの人数と、収益化の条件（500人）まであと何人かを表示する Web サイトです。

- サイト本体: `index.html`（GitHub Pages で公開予定: https://n0tya.github.io/verified-checker/ ）
- 中継サーバー: `worker/`（Cloudflare Workers: https://verified-checker.n0tya.workers.dev ）
- デモ表示: `?demo=premium`（人数が出る場合）、`?demo=free`（Premium でない場合）

## しくみ

- X は `verified_followers_count` を「ログインした本人」かつ「X Premium 加入者」にしか返しません。`/2/users/by/username` に app-only の Bearer Token で問い合わせても null になります（2026-11-13 に本番で確認）。
- そのため、訪問者に X でログインしてもらい（OAuth 2.0 + PKCE、scope は `users.read tweet.read`）、`GET /2/users/me` を1回だけ呼びます。
- トークンは取得のあとすぐ取り消し、保存しません。結果は URL の `#` 以降に入れてサイトに戻します。サーバーに残るのは、日付ごと・種類ごとの利用回数（D1）だけです。
- 料金はログイン1回につき約 $0.01（User 読み取り1件）。1つの IP からのログインは60秒に10回まで。**X Developer Console の月の上限額を必ず設定してください。**

## 設定（あなたが行う作業）

### X Developer Console
1. App の「ユーザー認証設定」で「セットアップ」を押す
2. アプリの権限: **読み取り**
3. アプリの種類: **ウェブアプリ、自動化されたアプリまたはボット**（Confidential client）
4. コールバック URI: `https://verified-checker.n0tya.workers.dev/auth/callback`
5. ウェブサイト URL: `https://n0tya.github.io/verified-checker/`
6. 保存すると表示される **Client ID** と **Client Secret** を控える（チャットには貼らない）

### Cloudflare に登録
```bash
cd verified-checker/worker
npx wrangler@4 secret put X_CLIENT_ID
npx wrangler@4 secret put X_CLIENT_SECRET
```

以前の方式で登録した `X_BEARER_TOKEN` は使っていません。消すときは `npx wrangler@4 secret delete X_BEARER_TOKEN` を実行します。

### 利用回数と管理ページ
- 利用回数は D1 データベース `verified-checker-stats` の `daily` テーブルに、日付（日本時間）と種類ごとに数えています（`worker/schema.sql`）。
- 公開サイトには管理ページを置いていません。数字は Cloudflare にログインしているパソコンから wrangler で読み出します（Worker には読み出し用の入口がありません）。例:
```bash
npx wrangler@4 d1 execute verified-checker-stats --remote --command "SELECT * FROM daily ORDER BY day DESC LIMIT 50"
```
- テーブルを作り直すとき: `npx wrangler@4 d1 execute verified-checker-stats --remote --file schema.sql`

### コードを変えたとき
```bash
npx wrangler@4 deploy
```

## メモ
- 収益化の条件は変わることがあります。`index.html` の `GOAL` と「収益化の条件について」を、そのときの条件に合わせて直してください。
- Premium のアカウントで本物の人数が出るかは、まだ確かめていません（作者のアカウントは Premium 未加入）。確かめられたら「ベータ」の表示を外します。
