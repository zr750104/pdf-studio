#!/bin/bash
# 新しい版を GitHub Releases に公開する。公開した版はインストール済みのアプリに自動アップデートで届く。
# 使い方: scripts/release.sh [リリースノートのファイル]
#   事前に package.json の version を上げ、`gh auth login` でログインしておくこと。
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$PWD/.tools/node/bin:$PATH"
REPO="zr750104/pdf-studio"
VERSION=$(node -p 'require("./package.json").version')
NOTES="${1:-release-notes.md}"

gh auth status >/dev/null 2>&1 || { echo "GitHub にログインしていません。先に 'gh auth login' を実行してください。"; exit 1; }
if gh release view "v$VERSION" --repo "$REPO" >/dev/null 2>&1; then
  echo "v$VERSION はすでに公開されています。package.json の version を上げてください。"; exit 1
fi
# リポジトリがなければ作る（ソースコードと配布ページ。Windows 版・Mac 版共通）
if ! gh repo view "$REPO" >/dev/null 2>&1; then
  gh repo create "$REPO" --public --add-readme --description "PDF Studio（Windows / Mac）のソースコードと配布ページ"
fi

export GH_TOKEN="$(gh auth token)"
node scripts/vendor.js
# dist は消さない（同じ名前の出力は上書きされ、公開されるのは今回作ったファイルだけ）
ELECTRON_BUILDER_NSIS_DIR="$PWD/.tools/nsis" ./node_modules/.bin/electron-builder --win --x64 --publish always

# electron-builder は下書きの場合があるので、公開状態とリリースノートを確定させる
if [ -f "$NOTES" ]; then
  gh release edit "v$VERSION" --repo "$REPO" --title "PDF Studio $VERSION" --notes-file "$NOTES" --draft=false --latest
else
  gh release edit "v$VERSION" --repo "$REPO" --title "PDF Studio $VERSION" --draft=false --latest
fi
echo "公開しました: https://github.com/$REPO/releases/tag/v$VERSION"
