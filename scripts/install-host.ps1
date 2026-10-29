# Installs the BeddCode host on a Windows machine without the desktop app, and runs it in the background:
#
#   irm https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.ps1 | iex
#
# With options, run it as a script block instead:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.ps1))) -NoService
#
# It needs Windows PowerShell 5.1 or PowerShell 7 and no administrator rights. It uses the Node.js 22+
# already on the machine; without one it downloads the official Node 22 into its own folder (nothing is
# installed system-wide). Options:
#   -Version <tag>   install that release (default: the latest)
#   -NoService       unpack only; do not start it in the background
#   -OwnNode         use a private Node 22 even when the machine has one
# Variables: BEDDCODE_PREFIX (where it unpacks, default %LOCALAPPDATA%\beddcode-host),
#            BEDDCODE_BIN (where the command goes, default %USERPROFILE%\.local\bin; added to your user PATH).
param(
  [string]$Version = 'latest',
  [switch]$NoService,
  [switch]$OwnNode
)

# Everything runs inside a function, so a failure throws instead of closing the window when piped to iex.
function Install-BeddCodeHost {
  param([string]$Version, [bool]$Service, [bool]$OwnNode)

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is far slower with its progress bar.
  # Windows PowerShell 5.1 may default to TLS 1.0, which GitHub and nodejs.org refuse.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = '0xbasinas/BeddCode'
  $asset = 'beddcode-host-win-x64.zip'
  $task = 'BeddCode Server' # The same scheduled task `beddcode host install` makes, so `host uninstall` removes it.
  $prefix = if ($env:BEDDCODE_PREFIX) { $env:BEDDCODE_PREFIX } else { Join-Path $env:LOCALAPPDATA 'beddcode-host' }
  $bin = if ($env:BEDDCODE_BIN) { $env:BEDDCODE_BIN } else { Join-Path $env:USERPROFILE '.local\bin' }
  $prefix = [IO.Path]::GetFullPath($prefix)
  $bin = [IO.Path]::GetFullPath($bin)

  function Fail([string]$message) { throw "error: $message" }
  function Get-File([string]$url, [string]$path) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $path }

  if ($env:OS -ne 'Windows_NT') { Fail 'this installer is for Windows; on Linux use scripts/install-host.sh' }
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -ne 'AMD64') { Fail "only x64 is built so far (this is $arch)" }

  $needNode = $true
  if (-not $OwnNode -and (Get-Command node -ErrorAction SilentlyContinue)) {
    $major = 0
    try { $major = [int](& node -p 'process.versions.node.split(".")[0]' 2>$null) } catch {}
    if ($major -ge 22) { $needNode = $false }
  }

  $url = if ($Version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download/$asset"
  } else {
    "https://github.com/$repo/releases/download/$Version/$asset"
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("beddcode-host-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading $url"
    try { Get-File $url (Join-Path $tmp $asset) } catch { Fail "download failed; is there a release with ${asset}? ($($_.Exception.Message))" }

    $unpacked = Join-Path $tmp 'unpacked'
    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath $unpacked -Force
    if (-not (Test-Path (Join-Path $unpacked 'server\main.mjs'))) { Fail 'the download is not a BeddCode host' }

    # Without a usable Node, fetch the official Node 22 into the host's own folder. The launcher prefers
    # it, and the background task runs with it. The download is checked against nodejs.org's hashes.
    if ($needNode) {
      $base = 'https://nodejs.org/dist/latest-v22.x'
      $sums = Join-Path $tmp 'SHASUMS256.txt'
      try { Get-File "$base/SHASUMS256.txt" $sums } catch { Fail 'could not reach nodejs.org' }
      $line = Get-Content $sums | Where-Object { $_ -match '^[0-9a-f]{64}\s+node-v22\.[0-9.]+-win-x64\.zip$' } | Select-Object -First 1
      if (-not $line) { Fail 'no Node 22 build found for win-x64' }
      $hash, $file = $line -split '\s+', 2
      Write-Host "Downloading Node.js ($file)"
      $zip = Join-Path $tmp $file
      try { Get-File "$base/$file" $zip } catch { Fail 'Node download failed' }
      if ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash -ne $hash.ToUpperInvariant()) { Fail 'Node download did not match its checksum' }
      $nodeTmp = Join-Path $tmp 'node'
      Expand-Archive -Path $zip -DestinationPath $nodeTmp -Force
      # The zip holds one folder (node-v22.x.y-win-x64); keep its contents as node\.
      $inner = Get-ChildItem -Path $nodeTmp -Directory | Select-Object -First 1
      if (-not $inner -or -not (Test-Path (Join-Path $inner.FullName 'node.exe'))) { Fail 'could not unpack Node' }
      Move-Item -Path $inner.FullName -Destination (Join-Path $unpacked 'node')
    }

    # A running host keeps its files open, and Windows will not move open files, so stop the one
    # installed here before swapping (it is started again below).
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    }
    $mine = [Regex]::Escape((Join-Path $prefix 'server\main.mjs'))
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match $mine } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500

    # Swap the new copy in only once it is complete, so a failed update leaves the old one working.
    New-Item -ItemType Directory -Force -Path (Split-Path $prefix -Parent), $bin | Out-Null
    $old = "$prefix.old"
    if (Test-Path $old) { Remove-Item -Recurse -Force $old }
    if (Test-Path $prefix) {
      try { Rename-Item -Path $prefix -NewName (Split-Path $old -Leaf) }
      catch { Fail "could not replace $prefix; is a beddcode command still running from it? ($($_.Exception.Message))" }
    }
    Move-Item -Path $unpacked -Destination $prefix
    if (Test-Path $old) { Remove-Item -Recurse -Force $old -ErrorAction SilentlyContinue }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  # The command on PATH: a small forwarder to the launcher in the install folder (Windows has no
  # symlinks for ordinary users).
  $launcher = Join-Path $prefix 'beddcode.cmd'
  $shim = Join-Path $bin 'beddcode.cmd'
  Set-Content -Path $shim -Encoding Ascii -Value "@echo off`r`n`"$launcher`" %*`r`nexit /b %ERRORLEVEL%"
  Write-Host "Installed to $prefix"

  # Put the command folder on the per-user PATH, as the desktop installer does for its own command.
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (($userPath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';'), 'User')
    Write-Host "Added $bin to your PATH; open a new terminal to use the beddcode command."
  }
  if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }

  if ($Service) {
    # Run it in the background whenever you sign in, as `beddcode host install` does, but through a
    # hidden PowerShell window: the host is a console program, and a visible console window would
    # stop the host when closed. The task has no run-time limit and asks Task Scheduler to retry it if it fails.
    $command = "& '$($launcher.Replace("'", "''"))' serve; exit `$LASTEXITCODE"
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`""
    $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\$env:USERNAME" } else { $env:USERNAME }
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal `
      -Settings $settings -Description 'BeddCode host' -Force | Out-Null
    Start-ScheduledTask -TaskName $task
    Write-Host "Started the host in the background; it starts whenever you sign in to Windows (task `"$task`")."
    Write-Host
    Write-Host 'Pair your phone or another computer with:  beddcode pair'
    Write-Host 'Check everything with:  beddcode doctor   (it also lists the agent CLIs you still need)'
    Write-Host 'Stop and remove the background task with:  beddcode host uninstall'
  }
}

Install-BeddCodeHost -Version $Version -Service (-not $NoService) -OwnNode $OwnNode
