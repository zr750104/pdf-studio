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

; 「プログラムから開く」に出るアプリ名を「PDF Studio」にする。
; Windows は exe の説明文を覚えておく（MuiCache）ため、説明文が「Electron」だった古い版を入れたことがある PC では
; exe を直しても「Electron」と出続ける。表示名をはっきり登録し、覚えている古い名前を消す。
; SupportedTypes を書かないと、関係ないファイルの「プログラムから開く」にも出てしまう。
; キー名は macro の中で組み立てる（APP_EXECUTABLE_FILENAME はこのファイルより後で定義されることがあるため）
!macro customInstall
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName" "${PRODUCT_NAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".tif" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".tiff" ""
  DeleteRegValue HKCU "Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache" "$INSTDIR\${APP_EXECUTABLE_FILENAME}.FriendlyAppName"
  DeleteRegValue HKCU "Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache" "$INSTDIR\${APP_EXECUTABLE_FILENAME}.ApplicationCompany"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

; アンインストールでは自分で書いた値だけを消す（更新のときは新しい版がすぐ書き直すので消さない）
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}" "FriendlyAppName"
    DeleteRegValue SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".pdf"
    DeleteRegValue SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".tif"
    DeleteRegValue SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes" ".tiff"
    DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}\SupportedTypes"
    DeleteRegKey /ifempty SHCTX "Software\Classes\Applications\${APP_EXECUTABLE_FILENAME}"
  ${endIf}
!macroend
