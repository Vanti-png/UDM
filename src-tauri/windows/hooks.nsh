; Installer hooks for the browser link's native messaging host.
;
; `ud-bridge.exe` is installed beside the app, and a browser starts it for a
; moment whenever the signed-in session changes -- whether or not the app is
; running. Tauri's own check only looks for the main program, so an install
; that lands on one of those moments finds the file open and stops at an
; Abort / Retry / Ignore box. That box is the one thing an unattended update
; cannot answer, and on uninstall the same moment leaves the file behind.
;
; The helper keeps nothing in memory -- every message is one process that
; answers from files and exits -- so ending it costs at most one push, which
; the extension sends again at the next cookie change.

!macro NSIS_HOOK_PREINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "ud-bridge.exe"
  Pop $R0
!macroend

; The product was called Universal Downloader before. The name keys the
; uninstall entry and the install folder, so this build lands beside a copy
; installed then rather than over it. Once this one is in place, the old copy's
; own uninstaller takes its program files, shortcuts and entry away. Run
; silently it never shows the "delete app data" box, so settings, history and
; downloads stay; they live under names the rename did not touch.
;
; An update runs this installer with /UPDATE, which makes no shortcuts of its
; own, and the old ones go with the old copy -- so they are made here.
!define OLD_PRODUCTNAME "Universal Downloader"

!macro NSIS_HOOK_POSTINSTALL
  ReadRegStr $R8 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${OLD_PRODUCTNAME}" "UninstallString"
  ReadRegStr $R9 HKCU "Software\${OLD_PRODUCTNAME}\${OLD_PRODUCTNAME}" ""
  ${If} $R8 != ""
  ${AndIf} $R9 != ""
  ${AndIf} $R9 != $INSTDIR
    ${IfNot} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
      CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    ${EndIf}
    ${If} ${FileExists} "$DESKTOP\${OLD_PRODUCTNAME}.lnk"
    ${AndIfNot} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
      CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe"
      !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"
    ${EndIf}

    ; `_?=` runs it in place and waits; it cannot delete itself from there.
    ; A failed run leaves the old copy as it was, entry and all, rather than
    ; half gone.
    ClearErrors
    ExecWait '$R8 /S _?=$R9' $R7
    ${IfNot} ${Errors}
    ${AndIf} $R7 = 0
      Delete "$R9\uninstall.exe"
      RMDir "$R9"
      DeleteRegKey HKCU "Software\${OLD_PRODUCTNAME}\${OLD_PRODUCTNAME}"
      DeleteRegKey /ifempty HKCU "Software\${OLD_PRODUCTNAME}"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsis_tauri_utils::KillProcessCurrentUser "ud-bridge.exe"
  Pop $R0
!macroend
