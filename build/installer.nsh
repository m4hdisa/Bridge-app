; Bridge's additions to electron-builder's installer: an optional page that installs the Per-App
; driver (ProxiFyre with Windows Packet Filter, see src/main/perapp.ts) along with Bridge, so
; Per-App works like Proxifier from the first connection. Offline: the files come with Bridge.
; Saved as UTF-8 with a BOM, which NSIS needs to read the Persian text.

!include nsDialogs.nsh

; The uninstaller is built from this file too, without these pages.
!ifndef BUILD_UNINSTALLER
  Var installDriver
  Var driverCheckbox
!endif

!macro customPageAfterChangeDir
  Page custom driverPageShow driverPageLeave

  Function driverPageShow
    ; Updates keep whatever the user chose before; an installed driver needs nothing.
    ${if} ${isUpdated}
      Abort
    ${endif}
    ${if} ${FileExists} "$PROGRAMFILES64\ProxiFyre\ProxiFyre.exe"
      Abort
    ${endif}
    !insertmacro MUI_HEADER_TEXT "Per-App driver  |  درایور برنامه‌محور" "Optional, recommended for Per-App mode  |  اختیاری، برای حالت برنامه‌محور پیشنهاد می‌شود"
    nsDialogs::Create 1018
    Pop $0
    ${NSD_CreateLabel} 0 0 100% 40u "With this driver, Per-App works like Proxifier: only the apps you choose are sent to the VPN, so connecting, disconnecting or switching servers never interrupts other apps, such as games. Everything comes with Bridge, nothing is downloaded; Windows asks for permission once."
    Pop $0
    ${NSD_CreateLabel} 0 42u 100% 40u "با این درایور، حالت برنامه‌محور مثل Proxifier کار می‌کند: فقط برنامه‌هایی که انتخاب می‌کنید به VPN فرستاده می‌شوند، پس وصل شدن، قطع شدن یا عوض کردن سرور برنامه‌های دیگر مثل بازی‌ها را قطع نمی‌کند. همه چیز همراه Bridge است و چیزی دانلود نمی‌شود؛ ویندوز یک بار اجازه می‌خواهد."
    Pop $0
    ${NSD_CreateCheckbox} 0 86u 100% 12u "Install the Per-App driver  |  درایور برنامه‌محور نصب شود"
    Pop $driverCheckbox
    ${NSD_Check} $driverCheckbox
    ${NSD_CreateLabel} 0 102u 100% 36u "Installs ProxiFyre (AGPL-3.0), Windows Packet Filter (NT KERNEL, free for non-commercial use, under its EULA) and the Microsoft Visual C++ runtime; their licenses are in Bridge's resources\proxifyre folder. You can also install it later from the Apps page.  |  بعداً هم از صفحه‌ی برنامه‌ها می‌شود نصبش کرد."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function driverPageLeave
    ${NSD_GetState} $driverCheckbox $installDriver
  FunctionEnd
!macroend

!macro customInstall
  ${if} $installDriver == ${BST_CHECKED}
    DetailPrint "Installing the Per-App driver (ProxiFyre with Windows Packet Filter)..."
    ; Bridge installs for this user without admin rights; the driver needs them, so this one step
    ; asks Windows. The script checks every file's hash and logs to %TEMP%\bridge-install-driver.log.
    ; Sysnative: the 64-bit PowerShell, since this installer is 32-bit (the script also checks).
    ExecShellWait "runas" "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\proxifyre\install-driver.ps1"' SW_HIDE
    DetailPrint "Per-App driver step finished"
  ${endif}
!macroend
