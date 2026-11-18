#!/bin/bash
# PDF Studio.app をビルドする。 ./build_app.sh --install で /Applications にもコピー
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="PDFStudio"
APP_DIR="PDF Studio.app"

echo "ビルド中 (release)..."
swift build -c release

echo "アイコン生成..."
mkdir -p build
swift make_icon.swift
iconutil -c icns build/AppIcon.iconset -o build/AppIcon.icns

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
cp ".build/release/$APP_NAME" "$APP_DIR/Contents/MacOS/$APP_NAME"
cp Info.plist "$APP_DIR/Contents/Info.plist"
cp build/AppIcon.icns "$APP_DIR/Contents/Resources/AppIcon.icns"
# 表示言語の訳
cp -R Sources/PDFStudio/Resources/i18n "$APP_DIR/Contents/Resources/i18n"

echo "アドホック署名..."
codesign --force --deep --sign - "$APP_DIR"

if [[ "${1:-}" == "--zip" ]]; then
    VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" Info.plist)
    mkdir -p dist
    ZIP="dist/PDF-Studio-Mac-${VERSION}.zip"
    rm -f "$ZIP"
    # Finder の「圧縮」と同じ形式（拡張属性・署名を保つ）
    ditto -c -k --sequesterRsrc --keepParent "$APP_DIR" "$ZIP"
    echo "配布用: $ZIP"
fi

if [[ "${1:-}" == "--install" ]]; then
    rm -rf "/Applications/$APP_DIR"
    cp -R "$APP_DIR" /Applications/
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/$APP_DIR"
    echo "インストール完了: /Applications/$APP_DIR"
else
    echo "完了: $(pwd)/$APP_DIR"
fi
