# Installs Bridge's Per-App driver from the files next to this script, without the internet:
# the Microsoft Visual C++ runtime (only when it is missing or older), Windows Packet Filter and
# ProxiFyre. Run elevated, by Bridge's installer or its Apps page (see src/main/perapp.ts).
# Exit code: 0 when everything is in place, 3010 when Windows needs a restart first, anything
# else when a step failed (written to install-driver.log in %TEMP%).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:TEMP 'bridge-install-driver.log'
function Note($text) { Add-Content -LiteralPath $log -Value ("{0:s} {1}" -f (Get-Date), $text) }

# Bridge's installer is a 32-bit program, so it starts the 32-bit PowerShell, which sees SysWOW64 as
# System32: it would find the 32-bit Visual C++ runtime, skip the 64-bit one ProxiFyre needs, and
# ProxiFyre's MSI would then refuse to install. Always do the work in 64-bit PowerShell.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  Note 'Started as 32-bit; running again as 64-bit'
  $ps64 = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
  $p = Start-Process -FilePath $ps64 -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$($MyInvocation.MyCommand.Path)`"" -Wait -PassThru -WindowStyle Hidden
  exit $p.ExitCode
}

# Same files and hashes as scripts/fetch-core.mjs.
$packages = @(
  @{ Name = 'vc'; File = 'VC_redist-14.44.35211-x64.exe.bin'; Sha256 = 'cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b'; Ext = '.exe' },
  @{ Name = 'wpf'; File = 'WindowsPacketFilter-3.6.2.1-x64.msi.bin'; Sha256 = '9c388c0b7f189f7fa98720bae2caecf7d64f30910838b80b438ecf8956b8502c'; Ext = '.msi' },
  @{ Name = 'proxifyre'; File = 'ProxiFyre-2.6.4-win-x64.msi.bin'; Sha256 = 'ef64b295485cd16ad3e41a6b7d56e7ab46da2093ff64389edc17545157777de1'; Ext = '.msi' }
)

function Run($exe, $arguments) {
  $p = Start-Process -FilePath $exe -ArgumentList $arguments -Wait -PassThru -WindowStyle Normal
  return $p.ExitCode
}

# Success codes: done, done but restart needed (3010, 1641), or already there (1638, newer VC++).
function Done($name, $code) {
  Note "$name finished with code $code"
  if ($code -eq 3010 -or $code -eq 1641) { $script:restart = $true; return }
  if ($code -ne 0 -and $code -ne 1638) { exit $code }
}

function FileVersion($path) {
  if (-not (Test-Path -LiteralPath $path)) { return [version]'0.0' }
  $v = (Get-Item -LiteralPath $path).VersionInfo
  return [version]('{0}.{1}.{2}.{3}' -f $v.FileMajorPart, $v.FileMinorPart, $v.FileBuildPart, $v.FilePrivatePart)
}

try {
  Note "Installing the Per-App driver from $here"
  # ProxiFyre needs .NET Framework 4.7.2 (in Windows 10 since 1803 and in Windows 11).
  $net = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue).Release
  if (-not $net -or $net -lt 461808) { Note ".NET Framework 4.7.2 or later is missing ($net)"; exit 2 }

  # Copied out of Bridge's folder (which the user can write to) and checked before running elevated.
  $work = Join-Path $env:SystemRoot "Temp\bridge-perapp-$PID"
  New-Item -ItemType Directory -Path $work -Force | Out-Null
  $paths = @{}
  foreach ($p in $packages) {
    $target = Join-Path $work ($p.Name + $p.Ext)
    Copy-Item -LiteralPath (Join-Path $here $p.File) -Destination $target
    $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLower()
    if ($hash -ne $p.Sha256) { Note "$($p.File) is not the expected file ($hash)"; exit 3 }
    $paths[$p.Name] = $target
  }

  $script:restart = $false
  $system = [Environment]::SystemDirectory
  $needed = [version]'14.44.35211.0'
  $vcFiles = 'msvcp140.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'
  # The Universal CRT the runtime builds on (part of Windows 10 and 11), which ProxiFyre also requires.
  $ucrt = FileVersion (Join-Path $system 'ucrtbase.dll')
  Note "ucrtbase.dll $ucrt"
  if ($ucrt -lt [version]'10.0.10240.0') { Note 'The Universal C runtime (ucrtbase.dll) is missing or too old; install Windows updates'; exit 4 }
  $oldVc = { @($vcFiles | Where-Object { (FileVersion (Join-Path $system $_)) -lt $needed }) }
  Note ('Visual C++ files: ' + (($vcFiles | ForEach-Object { "$_ $(FileVersion (Join-Path $system $_))" }) -join ', '))
  $missing = & $oldVc
  if ($missing.Count) {
    # When Windows already lists this runtime as installed, "/install" does nothing (1638) even if the
    # files themselves are older or damaged; "/repair" puts them back. ProxiFyre's own setup does the same.
    $reg = Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64' -ErrorAction SilentlyContinue
    $registered = $reg -and $reg.Installed -eq 1 -and [version]('{0}.{1}.{2}' -f $reg.Major, $reg.Minor, $reg.Bld) -ge [version]'14.44.35211'
    Note "Visual C++ runtime too old or missing: $($missing -join ', '); registered: $(if ($reg) { '{0}.{1}.{2}' -f $reg.Major, $reg.Minor, $reg.Bld } else { 'no' })"
    foreach ($verb in @(if ($registered) { '/repair' } else { '/install', '/repair' })) {
      Done "Visual C++ runtime $verb" (Run $paths.vc "$verb /quiet /norestart")
      $missing = & $oldVc
      if (-not $missing.Count) { break }
    }
    # ProxiFyre's MSI checks these same files; if they are still old (Windows replaces files in use
    # only at the next restart), stop here instead of letting it fail.
    if ($missing.Count) { Note "Still too old: $($missing -join ', '); restart Windows and install again"; exit 3010 }
  } else { Note 'Visual C++ runtime is already installed' }

  $driver = FileVersion (Join-Path $system 'drivers\ndisrd.sys')
  if ($driver -lt [version]'3.6.1.0' -or $driver -ge [version]'4.0.0.0') {
    Done 'Windows Packet Filter' (Run 'msiexec.exe' "/i `"$($paths.wpf)`" /qb! /norestart")
  } else { Note "Windows Packet Filter $driver is already installed" }

  # ProxiFyre's MSI checks the Visual C++ files again by itself, and on some PCs that check fails
  # although the files above are the right version (it did on a Windows 11 PC). Its own setup skips
  # that check with these two properties after checking the runtime first, as this script just did;
  # they are used nowhere else in the MSI, and its driver and .NET checks still run.
  $msiLog = Join-Path $env:TEMP 'bridge-proxifyre-msi.log'
  $code = Run 'msiexec.exe' "/i `"$($paths.proxifyre)`" /qb! /norestart /l*v `"$msiLog`" BURNMSIINSTALL=1 PROXIFYRE_SETUP_CHAIN=1"
  if ($code -ne 0 -and $code -ne 3010 -and $code -ne 1641) {
    # Why it failed, from its own log (full log: %TEMP%\bridge-proxifyre-msi.log).
    Get-Content -LiteralPath $msiLog -ErrorAction SilentlyContinue |
      Where-Object { $_ -match 'AppSearch: Property|LaunchCondition|Return value 3|Error \d{4}|Product: ' } |
      Select-Object -Last 15 | ForEach-Object { Note ("msi: " + $_.Trim()) }
  }
  Done 'ProxiFyre' $code

  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  if ($script:restart) { exit 3010 }
  exit 0
} catch {
  Note "Failed: $_"
  exit 1
}
