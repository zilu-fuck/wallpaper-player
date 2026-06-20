param(
  [int]$DurationMinutes = 60,
  [string]$PackageName = "com.wallpaperplayer.mobile",
  [string]$DesktopBaseUrl = "",
  [string]$OutputDir = "docs/qa/mobile-real-device",
  [string]$AdbPath = "",
  [switch]$SkipMonkey
)

$ErrorActionPreference = "Stop"

function Write-Step($Message) {
  Write-Host "[qa] $Message"
}

function Resolve-AdbPath($ExplicitPath) {
  $candidates = @()
  if ($ExplicitPath) {
    $candidates += $ExplicitPath
  }
  $pathCommand = Get-Command adb -ErrorAction SilentlyContinue
  if ($pathCommand) {
    $candidates += $pathCommand.Source
  }
  if ($env:ANDROID_HOME) {
    $candidates += (Join-Path $env:ANDROID_HOME "platform-tools/adb.exe")
    $candidates += (Join-Path $env:ANDROID_HOME "platform-tools/adb")
  }
  if ($env:ANDROID_SDK_ROOT) {
    $candidates += (Join-Path $env:ANDROID_SDK_ROOT "platform-tools/adb.exe")
    $candidates += (Join-Path $env:ANDROID_SDK_ROOT "platform-tools/adb")
  }
  if ($env:LOCALAPPDATA) {
    $candidates += (Join-Path $env:LOCALAPPDATA "Android/Sdk/platform-tools/adb.exe")
  }

  foreach ($candidate in ($candidates | Where-Object { $_ } | Select-Object -Unique)) {
    if (Test-Path $candidate) {
      return (Resolve-Path $candidate).Path
    }
  }

  throw "Missing required command: adb. Install Android platform-tools, pass -AdbPath, or set ANDROID_HOME/ANDROID_SDK_ROOT/PATH."
}

function Run-Adb([string[]]$Arguments) {
  & $script:ResolvedAdbPath @Arguments
}

function Save-Text($Path, $Text) {
  $directory = Split-Path -Parent $Path
  if ($directory -and -not (Test-Path $directory)) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  $Text | Out-File -FilePath $Path -Encoding utf8
}

$script:ResolvedAdbPath = Resolve-AdbPath $AdbPath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $OutputDir $timestamp
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

Write-Step "Using adb: $script:ResolvedAdbPath"
Save-Text (Join-Path $runDir "adb-path.txt") $script:ResolvedAdbPath

$devices = Run-Adb @("devices", "-l") | Out-String
Save-Text (Join-Path $runDir "devices.txt") $devices
if ($devices -notmatch "`n\S+\s+device\b") {
  throw "No authorized Android device found. Connect a phone, enable USB debugging, and accept the authorization prompt."
}

Write-Step "Collecting device metadata"
Save-Text (Join-Path $runDir "getprop.txt") (Run-Adb @("shell", "getprop") | Out-String)
Save-Text (Join-Path $runDir "wm-size.txt") (Run-Adb @("shell", "wm", "size") | Out-String)
Save-Text (Join-Path $runDir "wm-density.txt") (Run-Adb @("shell", "wm", "density") | Out-String)
Save-Text (Join-Path $runDir "package-path.txt") (Run-Adb @("shell", "pm", "path", $PackageName) | Out-String)

Write-Step "Checking app process"
$pidText = Run-Adb @("shell", "pidof", $PackageName) | Out-String
Save-Text (Join-Path $runDir "pid-before.txt") $pidText
if (-not $pidText.Trim()) {
  Write-Step "App process is not running yet; launching package"
  Run-Adb @("shell", "monkey", "-p", $PackageName, "-c", "android.intent.category.LAUNCHER", "1") | Out-Null
  Start-Sleep -Seconds 5
  $pidText = Run-Adb @("shell", "pidof", $PackageName) | Out-String
  Save-Text (Join-Path $runDir "pid-after-launch.txt") $pidText
}
if (-not $pidText.Trim()) {
  throw "Unable to find or launch package $PackageName. Install the mobile app build before running real-device QA."
}

Write-Step "Resetting logcat buffer"
Run-Adb @("logcat", "-c") | Out-Null

if ($DesktopBaseUrl) {
  Write-Step "Checking desktop remote endpoint from PC"
  try {
    $info = Invoke-WebRequest -UseBasicParsing -Uri "$DesktopBaseUrl/v1/info" -TimeoutSec 5
    Save-Text (Join-Path $runDir "desktop-info.json") $info.Content
  } catch {
    Save-Text (Join-Path $runDir "desktop-info-error.txt") $_.Exception.Message
  }
}

Write-Step "Collecting baseline memory"
Save-Text (Join-Path $runDir "meminfo-before.txt") (Run-Adb @("shell", "dumpsys", "meminfo", $PackageName) | Out-String)

if (-not $SkipMonkey) {
  Write-Step "Running light in-app monkey events"
  $monkey = Run-Adb @(
    "shell", "monkey",
    "-p", $PackageName,
    "--pct-touch", "70",
    "--pct-motion", "20",
    "--pct-nav", "5",
    "--throttle", "250",
    "240"
  ) | Out-String
  Save-Text (Join-Path $runDir "monkey.txt") $monkey
}

Write-Step "Sampling for $DurationMinutes minute(s). Keep using the app according to docs/mobile-real-device-qa.md."
$sampleCount = [Math]::Max(1, $DurationMinutes)
for ($index = 0; $index -lt $sampleCount; $index += 1) {
  $sample = "{0:D3}" -f ($index + 1)
  Save-Text (Join-Path $runDir "meminfo-$sample.txt") (Run-Adb @("shell", "dumpsys", "meminfo", $PackageName) | Out-String)
  Save-Text (Join-Path $runDir "top-$sample.txt") (Run-Adb @("shell", "top", "-b", "-n", "1", "-o", "PID,USER,RES,CPU%,ARGS") | Out-String)
  if ($index -lt ($sampleCount - 1)) {
    Start-Sleep -Seconds 60
  }
}

Write-Step "Collecting final logs"
Save-Text (Join-Path $runDir "meminfo-after.txt") (Run-Adb @("shell", "dumpsys", "meminfo", $PackageName) | Out-String)
Save-Text (Join-Path $runDir "logcat.txt") (Run-Adb @("logcat", "-d", "-v", "time") | Out-String)
Save-Text (Join-Path $runDir "crash-lines.txt") (Run-Adb @("logcat", "-d", "-v", "brief", "*:E") | Select-String -Pattern $PackageName, "FATAL EXCEPTION", "AndroidRuntime" | Out-String)

$summary = @"
Wallpaper Player Mobile real-device QA capture

Run directory: $runDir
Package: $PackageName
Duration minutes: $DurationMinutes
Desktop endpoint: $DesktopBaseUrl
Skip monkey: $SkipMonkey

Manual pass/fail still must be filled using docs/mobile-real-device-qa.md.
"@
Save-Text (Join-Path $runDir "summary.txt") $summary
Write-Step "QA capture saved to $runDir"
