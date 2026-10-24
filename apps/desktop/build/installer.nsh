; Puts the `beddcode` command on the user's PATH while BeddCode is installed. It is the per-user PATH
; (the installer is per-user too), changed through PowerShell, which also tells running programs.
; New terminals see it; ones already open do not.

!macro customInstall
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\cli'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if (-not $$p) { $$p = '' }; if (($$p -split ';') -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', (($$p.TrimEnd(';') + ';' + $$d).TrimStart(';')), 'User') }"`
  Pop $0
!macroend

!macro customUnInstall
  nsExec::Exec `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = '$INSTDIR\resources\cli'; $$p = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$p) { [Environment]::SetEnvironmentVariable('Path', (($$p -split ';' | Where-Object { $$_ -and $$_ -ne $$d }) -join ';'), 'User') }"`
  Pop $0
!macroend
