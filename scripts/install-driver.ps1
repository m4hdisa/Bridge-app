# Installs (or with -Uninstall, removes) what Bridge's Per-App needs, from the files next to this
# script and without the internet: the Windows Packet Filter driver, kept out of Windows' list of
# installed apps since it belongs to Bridge, and a firewall rule that lets bridge-perapp.exe take
# the connections it redirects. A ProxiFyre that older Bridge versions installed is removed.
# Run elevated, by Bridge's installer, its uninstaller or its Apps page (see src/main/perapp.ts).
# Exit code: 0 when everything is in place, 3010 when Windows needs a restart first, anything
# else when a step failed (written to bridge-install-driver.log in %TEMP%).
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:TEMP 'bridge-install-driver.log'
function Note($text) { Add-Content -LiteralPath $log -Value ("{0:s} {1}" -f (Get-Date), $text) }

# Bridge's installer is a 32-bit program, so it starts the 32-bit PowerShell, which sees a different
# registry and System32. Always do the work in 64-bit PowerShell.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  Note 'Started as 32-bit; running again as 64-bit'
  $ps64 = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"")
  if ($Uninstall) { $arguments += '-Uninstall' }
  $p = Start-Process -FilePath $ps64 -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  exit $p.ExitCode
}

# Same file and hash as scripts/fetch-core.mjs.
$msiFile = 'WindowsPacketFilter-3.6.2.1-x64.msi.bin'
$msiSha256 = '9c388c0b7f189f7fa98720bae2caecf7d64f30910838b80b438ecf8956b8502c'
$helper = Join-Path $here 'bridge-perapp.exe'
$rule = 'Bridge Per-App'
# Where Bridge notes that it installed the driver, so its uninstaller removes only what it added.
$key = 'HKLM:\SOFTWARE\Bridge\PerApp'

function Run($exe, $arguments) {
  $p = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}

# [string], because COM refuses the wrapped string Join-Path returns (DISP_E_TYPEMISMATCH).
function MsiProductCode([string]$path) {
  $i = New-Object -ComObject WindowsInstaller.Installer
  $db = $i.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $i, @($path, 0))
  $v = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @("SELECT Value FROM Property WHERE Property='ProductCode'"))
  # [void]: anything left in the pipeline would become part of what this function returns.
  [void]$v.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $v, $null)
  $r = $v.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $v, $null)
  $code = $r.GetType().InvokeMember('StringData', 'GetProperty', $null, $r, 1)
  # Let go of the file, so msiexec and the clean-up after it don't find it locked.
  foreach ($o in @($r, $v, $db, $i)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($o) }
  return $code
}

function MsiProductInstalled([string]$code) {
  $i = New-Object -ComObject WindowsInstaller.Installer
  return $i.GetType().InvokeMember('ProductState', 'GetProperty', $null, $i, @($code)) -eq 5
}

# Whether Windows has the driver's service, the same thing Bridge checks (perAppDriverReady in
# src/main/perapp.ts). A ndisrd.sys left on disk does nothing without it. sc.exe's exit code, not
# its text, since that text is translated on some Windows languages.
function DriverService() {
  & sc.exe query NDISRD | Out-Null
  return $LASTEXITCODE -eq 0
}

function FirewallRule() {
  & netsh.exe advfirewall firewall delete rule name="$rule" | Out-Null
  & netsh.exe advfirewall firewall add rule name="$rule" dir=in action=allow program="$helper" enable=yes profile=any | Out-Null
  Note "Firewall rule '$rule' set for $helper"
}

# ProxiFyre, from Bridge 0.6.0 and 0.6.1: removed unless someone else set it up for themselves.
function RemoveProxiFyre() {
  $dir = Join-Path $env:ProgramFiles 'ProxiFyre'
  if (-not (Test-Path -LiteralPath (Join-Path $dir 'ProxiFyre.exe'))) { return }
  $config = Join-Path $dir 'app-config.json'
  $ours = -not (Test-Path -LiteralPath $config)
  if (-not $ours) { try { $ours = (Get-Content -Raw -LiteralPath $config | ConvertFrom-Json).writtenBy -eq 'Bridge' } catch {} }
  if (-not $ours) { Note 'ProxiFyre has its own settings, so it stays'; return }
  Stop-Service -Name ProxiFyreService -Force -ErrorAction SilentlyContinue
  $entry = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue |
    ForEach-Object { Get-ItemProperty $_.PSPath } | Where-Object { $_.DisplayName -like 'ProxiFyre*' } | Select-Object -First 1
  if ($entry) {
    $code = Run 'msiexec.exe' "/x $($entry.PSChildName) /qn /norestart"
    Note "Removed ProxiFyre (code $code); Bridge does its work itself now"
  }
}

try {
  if ($Uninstall) {
    Note 'Removing the Per-App driver'
    & netsh.exe advfirewall firewall delete rule name="$rule" | Out-Null
    $mine = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
    if ($mine -and $mine.DriverProductCode) {
      $code = Run 'msiexec.exe' "/x $($mine.DriverProductCode) /qn /norestart"
      Note "Windows Packet Filter removed with code $code"
    } else { Note 'Bridge did not install Windows Packet Filter, so it stays' }
    Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
    exit 0
  }

  Note "Installing the Per-App driver from $here"
  $restart = $false
  RemoveProxiFyre

  $system = [Environment]::SystemDirectory
  $sys = Join-Path $system 'drivers\ndisrd.sys'
  $driver = [version]'0.0'
  if (Test-Path -LiteralPath $sys) {
    $v = (Get-Item -LiteralPath $sys).VersionInfo
    $driver = [version]('{0}.{1}.{2}.{3}' -f $v.FileMajorPart, $v.FileMinorPart, $v.FileBuildPart, $v.FilePrivatePart)
  }
  $usable = $driver -ge [version]'3.6.1.0' -and $driver -lt [version]'4.0.0.0'
  if ($usable -and (DriverService)) {
    Note "Windows Packet Filter $driver is already installed"
  } else {
    if ($usable) { Note "ndisrd.sys $driver is on disk but its Windows service is missing; installing the driver again" }
    # Copied out of Bridge's folder (which the user can write to) and checked before running elevated.
    $work = Join-Path $env:SystemRoot "Temp\bridge-perapp-$PID"
    New-Item -ItemType Directory -Path $work -Force | Out-Null
    $msi = Join-Path $work 'wpf.msi'
    Copy-Item -LiteralPath (Join-Path $here $msiFile) -Destination $msi
    $hash = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $msiSha256) { Note "$msiFile is not the expected file ($hash)"; exit 3 }
    $product = MsiProductCode $msi
    # Windows does nothing for /i on a product it still lists, so a broken install comes off first.
    if (MsiProductInstalled $product) {
      $code = Run 'msiexec.exe' "/x $product /qn /norestart"
      Note "Removed the broken Windows Packet Filter install with code $code"
      if ($code -eq 3010 -or $code -eq 1641) { $restart = $true }
    }
    # ARPSYSTEMCOMPONENT keeps it out of the installed apps list; Bridge's uninstaller removes it.
    $code = Run 'msiexec.exe' "/i `"$msi`" /qn /norestart ARPSYSTEMCOMPONENT=1"
    Note "Windows Packet Filter finished with code $code"
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    if ($code -eq 3010 -or $code -eq 1641) { $restart = $true }
    elseif ($code -ne 0) { exit $code }
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -LiteralPath $key -Name DriverProductCode -Value $product
    if (-not $restart -and -not (DriverService)) { Note 'Windows Packet Filter installed, but its Windows service is still missing'; exit 1603 }
  }

  FirewallRule
  if ($restart) { exit 3010 }
  exit 0
} catch {
  Note "Failed: $_"
  exit 1
}
