# Installs the BeddCode host on a Windows machine without the desktop app, and runs it in the background:
#
#   irm https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.ps1 | iex
#
# With options, run it as a script block instead:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/0xbasinas/BeddCode/main/scripts/install-host.ps1))) -NoService
#
# Run it again to update (the background host is stopped, replaced and started again).
#
# It needs Windows PowerShell 5.1 or PowerShell 7 and no administrator rights (except -AtBoot). It uses
# the Node.js 22+ already on the machine; without one it downloads the official Node 22 into its own
# folder (nothing is installed system-wide). On Windows on ARM it runs the x64 build, with its own x64
# Node, through Windows' x64 emulation. Options:
#   -Version <tag>   install that release (default: the latest)
#   -NoService       unpack only; do not start it in the background
#   -OwnNode         use a private Node 22 even when the machine has one
#   -Port <n>        the port the background host listens on (default 3773, the desktop app's)
#   -AtBoot          start it with Windows, whether or not anyone is signed in (run as administrator)
#   -Uninstall       stop and remove the background host, the command and the install folder
#                    (your sessions and settings in %USERPROFILE%\.beddcode are kept)
# Variables: BEDDCODE_PREFIX (where it unpacks, default %LOCALAPPDATA%\beddcode-host),
#            BEDDCODE_BIN (where the command goes, default %USERPROFILE%\.local\bin; added to your user PATH).
param(
  [string]$Version = 'latest',
  [switch]$NoService,
  [switch]$OwnNode,
  [int]$Port = 3773,
  [switch]$AtBoot,
  [switch]$Uninstall
)

# Everything runs inside a function, so a failure throws instead of closing the window when piped to iex.
function Install-BeddCodeHost {
  param([string]$Version, [bool]$Service, [bool]$OwnNode, [int]$Port, [bool]$AtBoot, [bool]$Uninstall)

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
  if ($Port -lt 1 -or $Port -gt 65535) { Fail "-Port must be between 1 and 65535 (not $Port)" }
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  if ($arch -eq 'ARM64') {
    # Only x64 is built. Windows on ARM runs x64 programs, but the host's native terminal library is
    # x64, so it has to run on an x64 Node too: always use the private one.
    Write-Host 'Windows on ARM: using the x64 build and its own x64 Node (through emulation).'
    $OwnNode = $true
  } elseif ($arch -ne 'AMD64') {
    Fail "only x64 (and ARM64 through emulation) is supported (this is $arch)"
  }

  $launcher = Join-Path $prefix 'beddcode.cmd'
  $shim = Join-Path $bin 'beddcode.cmd'

  # Stops the host installed here: its scheduled task, then any of its node processes still running
  # (a running host keeps its files open, and Windows will not move or delete open files).
  function Stop-Host {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
      Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    }
    $mine = [Regex]::Escape((Join-Path $prefix 'server\main.mjs'))
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match $mine } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500
  }

  # What answers on the port, if anything: the host's /health, or $null.
  function Get-Health([int]$port) {
    try {
      $res = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/health"
      return ($res.Content | ConvertFrom-Json)
    } catch { return $null }
  }

  if ($Uninstall) {
    if (Test-Path $launcher) {
      & $launcher host uninstall
    } elseif (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
      Unregister-ScheduledTask -TaskName $task -Confirm:$false
    }
    Stop-Host
    if (Test-Path $prefix) { Remove-Item -Recurse -Force $prefix }
    if (Test-Path "$prefix.old") { Remove-Item -Recurse -Force "$prefix.old" -ErrorAction SilentlyContinue }
    # Only the forwarder this installer wrote; a beddcode.cmd from the desktop app lives elsewhere.
    if ((Test-Path $shim) -and ((Get-Content -Raw $shim) -match [Regex]::Escape($launcher))) { Remove-Item -Force $shim }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -and ($userPath -split ';') -contains $bin -and -not (Get-ChildItem -Path $bin -ErrorAction SilentlyContinue)) {
      # Take the folder off PATH only when nothing else is left in it.
      [Environment]::SetEnvironmentVariable('Path', (($userPath -split ';') | Where-Object { $_ -and $_ -ne $bin }) -join ';', 'User')
      Write-Host "Removed $bin from your PATH."
    }
    Write-Host "Removed the BeddCode host from $prefix. Your sessions and settings in $(Join-Path $env:USERPROFILE '.beddcode') are kept."
    return
  }

  if ($AtBoot -and $Service) {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { Fail '-AtBoot needs an administrator PowerShell (Windows only lets administrators register a task that runs while nobody is signed in)' }
  }

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
    # Releases carry the archive's SHA-256 next to it (older ones do not; then only the size is trusted).
    $sum = $null
    try { Get-File "$url.sha256" (Join-Path $tmp 'asset.sha256'); $sum = ((Get-Content (Join-Path $tmp 'asset.sha256') -Raw) -split '\s+')[0] } catch {}
    if ($sum) {
      if ((Get-FileHash -Algorithm SHA256 -Path (Join-Path $tmp $asset)).Hash -ne $sum.ToUpperInvariant()) { Fail "$asset did not match its checksum" }
    } else {
      Write-Warning "this release has no checksum for $asset; it was not verified"
    }

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

    # Stop the host installed here before swapping (it is started again below).
    Stop-Host

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

  if (-not $Service) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
      # An update of a host already set up to run in the background: start it again, as it was.
      Start-ScheduledTask -TaskName $task
      Write-Host "Started the background host again (task `"$task`")."
    } else {
      Write-Host 'Start it with:  beddcode serve   (or in the background:  beddcode host install)'
    }
    return
  }

  # Something else already answering on the port is usually the desktop app's own host. Two hosts
  # cannot share a port, so say what will happen instead of leaving a host that silently fails.
  $other = Get-Health $Port
  $desktop = Get-Process -Name 'BeddCode' -ErrorAction SilentlyContinue
  if ($other) {
    Write-Warning "A BeddCode host ($($other.version)) already answers on port $Port$(if ($desktop) { ', most likely the desktop app''s own' })."
    Write-Warning 'The background host starts once that one stops (it retries every minute). In its Automatic host setting the desktop app'
    Write-Warning 'uses the background host instead of starting its own: quit the app and open it again. Or install on another port with -Port.'
  }

  # `beddcode host install` registers the scheduled task (the same one `beddcode host uninstall` and the
  # desktop app's tray menu manage): no console window, no run-time limit, restarted if it fails.
  $hostArgs = @('host', 'install')
  if ($Port -ne 3773) { $hostArgs += @('--port', "$Port") }
  if ($AtBoot) { $hostArgs += '--at-boot' }
  & $launcher @hostArgs
  if ($LASTEXITCODE -ne 0) { Fail "could not set up the background host (beddcode $($hostArgs -join ' ') exited with $LASTEXITCODE)" }

  # Give it a few seconds to answer, then show where things stand.
  if (-not $other) {
    for ($i = 0; $i -lt 20 -and -not (Get-Health $Port); $i++) { Start-Sleep -Milliseconds 500 }
  }
  Write-Host
  $statusArgs = @('host', 'status')
  if ($Port -ne 3773) { $statusArgs += @('--port', "$Port") }
  & $launcher @statusArgs
  Write-Host
  Write-Host 'Pair your phone or another computer with:  beddcode pair'
  Write-Host 'Check everything with:  beddcode doctor   (it also lists the agent CLIs you still need)'
  Write-Host 'Update by running this installer again. Remove everything with -Uninstall, or only the background task with:  beddcode host uninstall'
}

Install-BeddCodeHost -Version $Version -Service (-not $NoService) -OwnNode $OwnNode -Port $Port -AtBoot $AtBoot -Uninstall $Uninstall
