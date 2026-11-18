; インストーラーの追加設定（electron-builder の nsis.include）
; いつも「このユーザーのみ」にインストールする。
; 「すべてのユーザー」も選べると、2 か所に入ってスタートメニューとデスクトップのショートカットが
; 別々の版を起動したり、更新が使っていない方へ入ったりするため（2026-10-22 に実際に起きた）。
; アンインストーラーには適用しない（すべてのユーザー向けに入った古い版も消せるように）。
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    StrCpy $isForceCurrentInstall "1"
  !endif
!macroend
