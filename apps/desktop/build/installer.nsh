; Puts the `beddcode` command on the user's PATH while BeddCode is installed. It is the per-user PATH
; (the installer is per-user too), changed through PowerShell, which also tells running programs.
; New terminals see it; ones already open do not.
;
; It also looks after the background host (`beddcode host install`, the "BeddCode Server" scheduled
; task) when that task runs this installation's copy: an update stops it with the app, so it is started
; again afterwards; an uninstall removes it, so it does not try to start a deleted program at every
; sign-in. A task set up by the host-only installer (another folder) is left alone.

!macro customInstall
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\cli'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $$p) { $$p = '' }; if (($$p -split ';') -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (($$p.TrimEnd(';') + ';' + $$d).TrimStart(';')), 'User') }"`
  Pop $0
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$x = (schtasks /Query /TN 'BeddCode Server' /XML 2>$$null) -join ''; if ($$x -match [Regex]::Escape('$INSTDIR\')) { schtasks /Run /TN 'BeddCode Server' | Out-Null }"`
  Pop $0
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$x = (schtasks /Query /TN 'BeddCode Server' /XML 2>$$null) -join ''; if ($$x -match [Regex]::Escape('$INSTDIR\')) { schtasks /End /TN 'BeddCode Server' | Out-Null; schtasks /Delete /TN 'BeddCode Server' /F | Out-Null }"`
    Pop $0
  ${endIf}
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\cli'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$p) { [Environment]::SetEnvironmentVariable('Path', (($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }) -join ';'), 'User') }"`
  Pop $0
!macroend
