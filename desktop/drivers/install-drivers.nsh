; Stream Live Virtual Driver Installation
; allowElevation=true gives the installer UAC admin rights.
; NOTE: OBS Studio is intentionally NOT bundled/installed.
;
; Two virtual devices are provided so calling apps (Zoom/Teams/Chrome/WhatsApp)
; can see & hear the AI output WITHOUT OBS:
;   1. "Stream Live Camera"     - UnityCapture DirectShow filter (video)
;   2. "Stream Live Microphone" - VB-Audio Virtual Cable (audio)
; Both are installed here and can be re-installed/repaired any time by running
;   drivers\Install-VirtualDevices.ps1   (right-click > Run with PowerShell).

!macro customInstall
  ; -- VB-Audio Virtual Cable (virtual microphone) -------------------------------
  ; VBCABLE uses Inno Setup - correct silent flag is /VERYSILENT not /S.
  ; The setup exe is NOT self-contained: it reads the .inf/.sys/.cat driver files
  ; from its own folder, so the WHOLE pack ships in drivers\vbcable\. Shipping the
  ; exe alone fails with "Missing 'inf' file or Driver package corrupted".
  ;
  ; The service the vendor inf installs is VBAudioVACMME (trailing E - see
  ; ServiceName in every vbMmeCable*.inf). The old build tested ...VBAudioVACMM,
  ; a key that only ever existed because our own WriteRegStr created it, so the
  ; skip branch was dead and the device rename went where the driver cannot read
  ; it. Verified on a machine that ran the 1.6.4 installer: VBAudioVACMME holds the
  ; real ImagePath and an EMPTY Parameters, VBAudioVACMM holds only our two names,
  ; and Windows still lists the device as "VB-Audio Virtual Cable".
  ;
  ; The vendor readme requires a reboot to finish, and states the package may not
  ; be integrated into another installer without the author's agreement. So the
  ; setup now runs with its OWN visible UI (licence page, progress, reboot notice)
  ; behind a prompt we ask first - /VERYSILENT is gone from this path.
  ClearErrors
  StrCpy $0 ""
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMME" "ImagePath"
  StrCmp $0 "" ss_vbc_absent ss_vbc_present

  ss_vbc_present:
    ; Left over from the old build: a key our installer created and the driver
    ; never reads. Removing it stops anyone from trusting it as proof of a device.
    DeleteRegKey HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMM"
    DetailPrint "Stream Live audio driver already installed - leaving it alone."
    Goto ss_vbc_done

  ss_vbc_absent:
    DeleteRegKey HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMM"
    IfFileExists "$INSTDIR\drivers\vbcable\VBCABLE_Setup_x64.exe" 0 ss_vbc_nofile
      MessageBox MB_YESNO|MB_ICONQUESTION \
        "Stream Live needs one free audio component so OBS, Zoom, Teams and calling \
         apps can hear the AI output: the VB-CABLE virtual audio driver.$\r$\n$\r$\n\
         Install it now?  The driver's own setup will open; after it finishes you \
         must RESTART the computer.$\r$\n$\r$\n\
         Choose No to install it yourself later." IDNO ss_vbc_declined
        SetOutPath "$INSTDIR\drivers\vbcable"
        ExecWait '"$INSTDIR\drivers\vbcable\VBCABLE_Setup_x64.exe"' $0
        SetOutPath "$INSTDIR"
        DetailPrint "Audio driver setup exit code: $0"
        Sleep 2000
        ClearErrors
        StrCpy $0 ""
        ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMME" "ImagePath"
        StrCmp $0 "" ss_vbc_failed
          WriteRegStr HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMME\Parameters" "DeviceName"    "Stream Live Microphone"
          WriteRegStr HKLM "SYSTEM\CurrentControlSet\Services\VBAudioVACMME\Parameters" "DeviceNameOut" "Stream Live Speaker"
          MessageBox MB_OK|MB_ICONINFORMATION \
            "The audio driver is installed.$\r$\n$\r$\n\
             RESTART THE COMPUTER now, then open OBS or your calling app and pick the \
             new cable device for both speaker and microphone. It appears as \
             'Stream Live Microphone' / 'Stream Live Speaker', or as 'CABLE Input' / \
             'CABLE Output' if the driver keeps its own name - either one is correct."
          Goto ss_vbc_done
        ss_vbc_failed:
          DetailPrint "Audio driver still not registered after setup."
          MessageBox MB_OK|MB_ICONEXCLAMATION \
            "The audio driver did not register. Restart the computer, then right-click \
             $INSTDIR\drivers\Install-VirtualDevices.ps1 and choose \
             'Run with PowerShell'."
          Goto ss_vbc_done
      ss_vbc_declined:
        DetailPrint "Audio driver declined by the user."
        Goto ss_vbc_done

  ss_vbc_nofile:
    DetailPrint "Audio driver pack missing from the installer."
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "The audio driver could not be installed automatically. Download it free from \
       https://vb-audio.com/Cable/ , run VBCABLE_Setup_x64.exe as administrator, \
       then restart the computer."

  ss_vbc_done:

  ; ── Stream Live Camera (UnityCapture DirectShow filter, verified) ─────────
  ; The PowerShell installer registers the 64-bit + 32-bit filters and VERIFIES
  ; them against the DirectShow registry, reporting real success/failure.
  ; -NoAudio because VB-Cable was just installed above.
  IfFileExists "$INSTDIR\drivers\Install-VirtualDevices.ps1" 0 +3
    DetailPrint "Registering Stream Live Camera virtual camera..."
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\drivers\Install-VirtualDevices.ps1" -NoAudio'

  ; ── Desktop icon for the signed-in user ──────────────────────────────────────
  ; Installing "for all users" (this installer needs admin for the drivers, so it
  ; usually does) puts the icon in C:\Users\Public\Desktop only. When OneDrive has
  ; taken over the Desktop folder, that copy is not what Explorer paints, and the
  ; install looks like it left no icon behind. Write one into the folder this user's
  ; Desktop actually resolves to, and only then - a per-user install already does it.
  ${if} $installMode == "all"
    SetShellVarContext current
      DetailPrint "Adding desktop icon for the current user..."
      CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
      SetShellVarContext all
  ${endIf}
  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'

  DetailPrint "Stream Live drivers installed."
!macroend

!macro customUnInstall
  ; Unregister the virtual camera (best effort) before files are removed.
  IfFileExists "$INSTDIR\drivers\Install-VirtualDevices.ps1" 0 +2
    nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\drivers\Install-VirtualDevices.ps1" -Uninstall -NoAudio'
  Delete "$INSTDIR\drivers\vbcable\VBCABLE_Setup_x64.exe"
  Delete "$INSTDIR\drivers\OBS-VirtualCam-Setup.exe"
  RMDir /r "$INSTDIR\drivers"
!macroend
