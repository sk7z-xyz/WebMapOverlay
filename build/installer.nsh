; 通常のアンインストール時だけ、Stormworks 起動待機タスクを確実に削除する。
; 更新時に削除すると起動連動設定が失われるため、更新用アンインストールでは維持する。
!macro customUnInstall
  ${IfNot} ${isUpdated}
    nsExec::ExecToStack '"$SYSDIR\schtasks.exe" /Query /TN "WebMap Overlay - Stormworks Launcher"'
    Pop $0
    Pop $1

    ; タスクが無い場合は、UACを表示せず通常のアンインストールを続ける。
    ${If} $0 == 0
      ${IfNot} ${UAC_IsAdmin}
        !insertmacro UAC_RunElevated
        ${Switch} $0
          ${Case} 0
            ; 昇格した子プロセスが削除を続行するため、親プロセスは終了する。
            ${If} $1 == 1
              Quit
            ${EndIf}
            ${Break}
          ${Case} 1223
            MessageBox MB_YESNO|MB_ICONEXCLAMATION "Windowsの管理者確認が拒否されたため、起動連動タスクを削除できませんでした。$\r$\n$\r$\nタスクを残したままアンインストールしますか？$\r$\n$\r$\n後で削除する方法：$\r$\n1. Windowsの「タスク スケジューラ」を管理者として開く$\r$\n2. 「タスク スケジューラ ライブラリ」を開く$\r$\n3. 「WebMap Overlay - Stormworks Launcher」を右クリックして「削除」" IDYES webmap_keep_task
            Abort
          ${Default}
            MessageBox MB_YESNO|MB_ICONEXCLAMATION "起動連動タスクの削除に必要な管理者権限を取得できませんでした。$\r$\n$\r$\nタスクを残したままアンインストールしますか？$\r$\n$\r$\n後で削除する方法：$\r$\n1. Windowsの「タスク スケジューラ」を管理者として開く$\r$\n2. 「タスク スケジューラ ライブラリ」を開く$\r$\n3. 「WebMap Overlay - Stormworks Launcher」を右クリックして「削除」" IDYES webmap_keep_task
            Abort
        ${EndSwitch}
      ${EndIf}

      nsExec::ExecToStack '"$SYSDIR\schtasks.exe" /End /TN "WebMap Overlay - Stormworks Launcher"'
      Pop $0
      Pop $1
      nsExec::ExecToStack '"$SYSDIR\schtasks.exe" /Delete /TN "WebMap Overlay - Stormworks Launcher" /F'
      Pop $0
      Pop $1
      ${If} $0 != 0
        MessageBox MB_YESNO|MB_ICONEXCLAMATION "起動連動タスクを削除できませんでした。$\r$\n$\r$\nタスクを残したままアンインストールしますか？$\r$\n$\r$\n後で削除する方法：$\r$\n1. Windowsの「タスク スケジューラ」を管理者として開く$\r$\n2. 「タスク スケジューラ ライブラリ」を開く$\r$\n3. 「WebMap Overlay - Stormworks Launcher」を右クリックして「削除」" IDYES webmap_keep_task
        Abort
      ${EndIf}
    ${EndIf}
    Goto webmap_task_cleanup_done

    webmap_keep_task:
      MessageBox MB_OK|MB_ICONINFORMATION "起動連動タスクを残したままアンインストールします。$\r$\n$\r$\n再インストール時に自動起動設定が有効と表示される場合があります。後でタスク スケジューラから「WebMap Overlay - Stormworks Launcher」を削除してください。"

    webmap_task_cleanup_done:
  ${EndIf}
!macroend
