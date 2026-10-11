<#
  Stream Studio - Virtual Device Installer
  ----------------------------------------
  Registers the "Stream Studio Camera" DirectShow virtual camera (UnityCapture
  filter) for both 64-bit and 32-bit calling apps, and installs the VB-Audio
  Virtual Cable ("Stream Studio Microphone").

  BITNESS-SAFE: this script is often launched from the 32-bit NSIS installer.
  Under WOW64, a 32-bit process writing HKLM:\SOFTWARE or calling
  System32\regsvr32 is silently redirected to the 32-bit view / 32-bit regsvr,
  which is why 64-bit apps (OBS, Zoom) never saw the registration. Every
  registry access here goes through an explicit RegistryView (Registry64 /
  Registry32) and regsvr32 is chosen via Sysnative so the correct bitness runs
  regardless of who launched us.

  Run manually (right-click > Run with PowerShell) or it is invoked silently by
  the Stream Studio setup. Requires Administrator; it self-elevates if needed.

  Exit codes: 0 = all requested components OK, 1 = one or more failed.
#>

[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$NoAudio,
  [switch]$NoVideo,
  [string]$CameraName = "Stream Studio Camera"
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

function Write-Step($m) { Write-Host "[ .. ] $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "[ OK ] $m" -ForegroundColor Green }
function Write-Bad($m)  { Write-Host "[FAIL] $m" -ForegroundColor Red }
function Write-Warn2($m){ Write-Host "[WARN] $m" -ForegroundColor Yellow }

# ── Self-elevate to Administrator ─────────────────────────────────────────────
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warn2 "Administrator rights required - relaunching elevated..."
  $args = @("-NoProfile","-ExecutionPolicy","Bypass","-File","`"$PSCommandPath`"")
  if ($Uninstall) { $args += "-Uninstall" }
  if ($NoAudio)   { $args += "-NoAudio" }
  if ($NoVideo)   { $args += "-NoVideo" }
  $p = Start-Process powershell.exe -Verb RunAs -ArgumentList $args -PassThru
  $p.WaitForExit()
  exit $p.ExitCode
}

$Root   = Split-Path -Parent $PSCommandPath
$CamDir = Join-Path $Root "virtual-camera"
$Dll64  = Join-Path $CamDir "UnityCaptureFilter64.dll"
$Dll32  = Join-Path $CamDir "UnityCaptureFilter32.dll"

# regsvr32 of the CORRECT bitness regardless of our own bitness.
$Sysnative = Join-Path $env:SystemRoot "Sysnative\regsvr32.exe"   # 64-bit regsvr from a 32-bit process
$Regsvr64  = if (Test-Path $Sysnative) { $Sysnative } else { Join-Path $env:SystemRoot "System32\regsvr32.exe" }
$Regsvr32  = Join-Path $env:SystemRoot "SysWOW64\regsvr32.exe"

$VideoCat   = '{860BB310-5D01-11d0-BD3B-00A0C911CE86}'           # CLSID_VideoInputDeviceCategory
$InstanceSub64 = "SOFTWARE\Classes\CLSID\$VideoCat\Instance"
$InstanceSub32 = "SOFTWARE\Classes\CLSID\$VideoCat\Instance"     # same sub-path, different RegistryView
$ClsidRootSub  = "SOFTWARE\Classes\CLSID"

$exit = 0

# ── Registry helpers with EXPLICIT view (immune to WOW64 redirection) ─────────
function Open-ViewKey([string]$view, [string]$sub, [bool]$writable) {
  $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  $k = $hive.OpenSubKey($sub, $writable)
  $hive.Close()
  return $k
}
function Get-ViewProp([string]$view, [string]$sub, [string]$name) {
  $k = Open-ViewKey $view $sub $false
  if (-not $k) { return $null }
  # .NET reads/writes the default value under an EMPTY name, not "(default)".
  if ($name -eq '(default)') { $name = '' }
  $v = $k.GetValue($name, $null)
  $k.Close()
  return $v
}
function Set-ViewProp([string]$view, [string]$sub, [string]$name, [string]$value) {
  $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  $k = $hive.CreateSubKey($sub)
  if ($name -eq '(default)') { $name = '' }
  $k.SetValue($name, $value)
  $k.Close()
  $hive.Close()
}
function Get-ViewSubKeys([string]$view, [string]$sub) {
  $k = Open-ViewKey $view $sub $false
  if (-not $k) { return @() }
  $n = $k.GetSubKeyNames()
  $k.Close()
  return $n
}
function Remove-ViewSubKey([string]$view, [string]$sub) {
  $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
  try { $hive.DeleteSubKeyTree($sub, $false) } catch {}
  $hive.Close()
}

function Test-CameraRegistered([string]$view, [string]$instanceSub, [string]$name) {
  foreach ($s in (Get-ViewSubKeys $view $instanceSub)) {
    if ((Get-ViewProp $view (Join-Path $instanceSub $s) 'FriendlyName') -eq $name) { return $true }
  }
  return $false
}

# Locate the filter CLSID by the DLL it loads from (name-independent).
function Find-FilterClsid([string]$dll, [string]$view) {
  if (-not (Test-Path $dll)) { return $null }
  $target = [System.IO.Path]::GetFullPath($dll)
  foreach ($s in (Get-ViewSubKeys $view $ClsidRootSub)) {
    $v = Get-ViewProp $view (Join-Path $ClsidRootSub (Join-Path $s 'InprocServer32')) '(default)'
    if ($v) {
      try { if ([System.IO.Path]::GetFullPath($v) -ieq $target) { return $s } } catch {}
    }
  }
  return $null
}

function Set-CategoryInstance([string]$view, [string]$instanceSub, [string]$clsid, [string]$name) {
  if (-not $clsid) { return $false }
  $sub = Join-Path $instanceSub $clsid
  Set-ViewProp $view $sub '(default)'   $name
  Set-ViewProp $view $sub 'FriendlyName' $name
  Set-ViewProp $view $sub 'CLSID'        $clsid
  return $true
}

# Some apps (OBS) show the filter's OWN name (CLSID default), not the category
# FriendlyName - overwrite it too so the device reads "Stream Studio Camera".
function Set-FilterDisplayName([string]$view, [string]$clsid, [string]$name) {
  if (-not $clsid) { return }
  Set-ViewProp $view (Join-Path $ClsidRootSub $clsid) '(default)' $name
}

function Remove-CategoryInstance([string]$view, [string]$instanceSub, [string]$name) {
  foreach ($s in (Get-ViewSubKeys $view $instanceSub)) {
    if ((Get-ViewProp $view (Join-Path $instanceSub $s) 'FriendlyName') -eq $name) {
      Remove-ViewSubKey $view (Join-Path $instanceSub $s)
    }
  }
}

function Invoke-Regsvr($exe, $dll, [switch]$Remove) {
  if (-not (Test-Path $exe)) { return 127 }
  if (-not (Test-Path $dll)) { return 126 }
  $u = if ($Remove) { "/u " } else { "" }
  $arg = "/s $u/i:`"UnityCaptureName=$CameraName`" `"$dll`""
  $p = Start-Process $exe -ArgumentList $arg -Wait -PassThru -WindowStyle Hidden
  return $p.ExitCode
}

# ── VIDEO: Stream Studio Camera (UnityCapture DirectShow filter) ──────────────
if (-not $NoVideo) {
  if ($Uninstall) {
    Write-Step "Unregistering '$CameraName'..."
    Remove-CategoryInstance 'Registry64' $InstanceSub64 $CameraName
    Remove-CategoryInstance 'Registry32' $InstanceSub32 $CameraName
    [void](Invoke-Regsvr $Regsvr64 $Dll64 -Remove)
    if (Test-Path $Regsvr32) { [void](Invoke-Regsvr $Regsvr32 $Dll32 -Remove) }
    if (Test-CameraRegistered 'Registry64' $InstanceSub64 $CameraName) { Write-Bad "64-bit camera still present"; $exit = 1 }
    else { Write-Ok "Camera unregistered." }
  }
  else {
    if (-not (Test-Path $Dll64)) {
      Write-Bad "Missing $Dll64 - cannot register virtual camera."
      $exit = 1
    } else {
      Write-Step "Registering 64-bit '$CameraName'..."
      $c64 = Invoke-Regsvr $Regsvr64 $Dll64
      $clsid64 = Find-FilterClsid $Dll64 'Registry64'
      if ($clsid64) {
        [void](Set-CategoryInstance 'Registry64' $InstanceSub64 $clsid64 $CameraName)
        Set-FilterDisplayName 'Registry64' $clsid64 $CameraName
      }
      if ($clsid64 -and (Test-CameraRegistered 'Registry64' $InstanceSub64 $CameraName)) {
        Write-Ok "64-bit camera registered and VERIFIED in DirectShow (CLSID $clsid64)."
      } else {
        Write-Bad "64-bit registration failed (regsvr32 exit $c64, clsid $clsid64)."
        $exit = 1
      }

      if (Test-Path $Regsvr32) {
        if (Test-Path $Dll32) {
          Write-Step "Registering 32-bit '$CameraName'..."
          $c32 = Invoke-Regsvr $Regsvr32 $Dll32
          $clsid32 = Find-FilterClsid $Dll32 'Registry32'
          if ($clsid32) {
            [void](Set-CategoryInstance 'Registry32' $InstanceSub32 $clsid32 $CameraName)
            Set-FilterDisplayName 'Registry32' $clsid32 $CameraName
          }
          if ($clsid32 -and (Test-CameraRegistered 'Registry32' $InstanceSub32 $CameraName)) {
            Write-Ok "32-bit camera registered and VERIFIED."
          } else {
            Write-Warn2 "32-bit registration incomplete (regsvr32 exit $c32, clsid $clsid32). 64-bit apps still work."
          }
        } else {
          Write-Warn2 "32-bit DLL not found; skipping 32-bit registration."
        }
      }
    }
  }
}

# ── AUDIO: VB-Audio Virtual Cable ("Stream Studio Microphone") ────────────────
if (-not $NoAudio) {
  # The setup exe reads its .inf/.sys/.cat siblings from its own folder, so the
  # full pack lives in drivers\vbcable\ (exe alone fails: "Missing 'inf' file").
  $vbSetup = Join-Path $Root "vbcable\VBCABLE_Setup_x64.exe"
  if (-not (Test-Path $vbSetup)) { $vbSetup = Join-Path $Root "VBCable_Setup_x64.exe" }
  if (-not (Test-Path $vbSetup)) { $vbSetup = Join-Path $Root "VBCABLE_Setup_x64.exe" }

  if ($Uninstall) {
    Write-Warn2 "VB-Cable is not removed automatically (shared system audio driver)."
    Write-Host "      Uninstall it from 'Apps & features' > 'VB-CABLE Virtual Audio Device' if desired."
  }
  else {
    $svc = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, 'Registry64').OpenSubKey('SYSTEM\CurrentControlSet\Services\VBAudioVACMM')
    $already = $null -ne $svc
    if ($svc) { $svc.Close() }
    if ($already) {
      Write-Ok "VB-Cable audio driver already installed."
    } elseif (Test-Path $vbSetup) {
      Write-Step "Installing VB-Audio Virtual Cable (Stream Studio Microphone)..."
      $p = Start-Process $vbSetup -ArgumentList "/VERYSILENT","/NORESTART","/SUPPRESSMSGBOXES" -Wait -PassThru
      Start-Sleep -Seconds 3
      $svc2 = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, 'Registry64').OpenSubKey('SYSTEM\CurrentControlSet\Services\VBAudioVACMM')
      if ($svc2) {
        $svc2.Close()
        Write-Ok "Audio driver installed and VERIFIED."
      } else {
        Write-Bad "Audio driver install did not register the VBAudioVACMM service (exit $($p.ExitCode))."
        $exit = 1
      }
    } else {
      Write-Warn2 "VBCable_Setup_x64.exe not found next to this script; skipping audio."
    }
  }
}

Write-Host ""
if ($exit -eq 0) { Write-Ok "Done. Restart any calling app (Zoom/Teams/OBS) to see the new devices." }
else             { Write-Bad "Completed with errors (exit $exit). See messages above." }
exit $exit
