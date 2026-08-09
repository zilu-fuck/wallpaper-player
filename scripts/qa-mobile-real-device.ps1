param(
  [int]$DurationMinutes = 60,
  [string]$PackageName = "com.wallpaperplayer.mobile",
  [string]$DesktopBaseUrl = "",
  [string]$OutputDir = "docs/qa/mobile-real-device",
  [string]$AdbPath = "",
  [ValidateSet("library-1k", "library-5k", "playback-60m", "low-memory-restore", "background-lock", "weak-network", "custom")]
  [string]$Scenario = "playback-60m",
  [int]$LibrarySize = 0,
  [int]$MaxPssGrowthMb = 120,
  [int]$MaxFinalPssMb = 900,
  [int]$DesktopPollSeconds = 60,
  [switch]$SendTrimMemory,
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

function Get-MeminfoTotalPssMb($Text) {
  foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match "TOTAL PSS:\s*([0-9,]+)") {
      return [Math]::Round(([double]($matches[1] -replace ",", "")) / 1024, 1)
    }
    if ($line -match "^\s*TOTAL\s+([0-9,]+)\s+") {
      return [Math]::Round(([double]($matches[1] -replace ",", "")) / 1024, 1)
    }
  }
  return $null
}

function Test-DesktopEndpoint($BaseUrl, $Path) {
  if (-not $BaseUrl) {
    return @{ checked = $false; ok = $true; status = ""; error = "" }
  }
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "$BaseUrl/v1/info" -TimeoutSec 5
    Save-Text $Path $response.Content
    return @{ checked = $true; ok = $true; status = "$($response.StatusCode)"; error = "" }
  } catch {
    Save-Text $Path $_.Exception.Message
    return @{ checked = $true; ok = $false; status = ""; error = $_.Exception.Message }
  }
}

$script:ResolvedAdbPath = Resolve-AdbPath $AdbPath
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $OutputDir $timestamp
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

Write-Step "Using adb: $script:ResolvedAdbPath"
Save-Text (Join-Path $runDir "adb-path.txt") $script:ResolvedAdbPath
Save-Text (Join-Path $runDir "scenario.txt") @"
Scenario: $Scenario
Library size: $LibrarySize
Duration minutes: $DurationMinutes
Max PSS growth MB: $MaxPssGrowthMb
Max final PSS MB: $MaxFinalPssMb
Desktop poll seconds: $DesktopPollSeconds
Send trim memory: $SendTrimMemory
"@

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
  Test-DesktopEndpoint $DesktopBaseUrl (Join-Path $runDir "desktop-info.json") | Out-Null
}

Write-Step "Collecting baseline memory"
$baselineMeminfo = Run-Adb @("shell", "dumpsys", "meminfo", $PackageName) | Out-String
Save-Text (Join-Path $runDir "meminfo-before.txt") $baselineMeminfo
$baselinePssMb = Get-MeminfoTotalPssMb $baselineMeminfo

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
$samples = @()
$desktopSamples = @()
$trimMemorySent = $false
for ($index = 0; $index -lt $sampleCount; $index += 1) {
  $sample = "{0:D3}" -f ($index + 1)
  $meminfo = Run-Adb @("shell", "dumpsys", "meminfo", $PackageName) | Out-String
  Save-Text (Join-Path $runDir "meminfo-$sample.txt") $meminfo
  $pssMb = Get-MeminfoTotalPssMb $meminfo
  $samples += @{
    minute = $index + 1
    totalPssMb = $pssMb
  }
  Save-Text (Join-Path $runDir "top-$sample.txt") (Run-Adb @("shell", "top", "-b", "-n", "1", "-o", "PID,USER,RES,CPU%,ARGS") | Out-String)

  if ($DesktopBaseUrl -and ($DesktopPollSeconds -gt 0) -and ((($index * 60) % $DesktopPollSeconds) -eq 0)) {
    $desktopSamples += Test-DesktopEndpoint $DesktopBaseUrl (Join-Path $runDir "desktop-info-$sample.json")
  }

  if (($SendTrimMemory -or $Scenario -eq "low-memory-restore") -and -not $trimMemorySent -and $index -ge [Math]::Floor($sampleCount / 2)) {
    Write-Step "Sending Android trim-memory signal"
    try {
      Save-Text (Join-Path $runDir "trim-memory.txt") (Run-Adb @("shell", "am", "send-trim-memory", $PackageName, "RUNNING_CRITICAL") | Out-String)
    } catch {
      Save-Text (Join-Path $runDir "trim-memory-error.txt") $_.Exception.Message
    }
    $trimMemorySent = $true
  }

  if ($index -lt ($sampleCount - 1)) {
    Start-Sleep -Seconds 60
  }
}

Write-Step "Collecting final logs"
$finalMeminfo = Run-Adb @("shell", "dumpsys", "meminfo", $PackageName) | Out-String
Save-Text (Join-Path $runDir "meminfo-after.txt") $finalMeminfo
$finalPssMb = Get-MeminfoTotalPssMb $finalMeminfo
Save-Text (Join-Path $runDir "logcat.txt") (Run-Adb @("logcat", "-d", "-v", "time") | Out-String)
$crashLines = Run-Adb @("logcat", "-d", "-v", "brief", "*:E") | Select-String -Pattern $PackageName, "FATAL EXCEPTION", "AndroidRuntime" | Out-String
Save-Text (Join-Path $runDir "crash-lines.txt") $crashLines

$validPssSamples = @($samples | Where-Object { $null -ne $_.totalPssMb } | ForEach-Object { [double]$_.totalPssMb })
$peakPssMb = if ($validPssSamples.Count -gt 0) { ($validPssSamples | Measure-Object -Maximum).Maximum } else { $null }
$growthPssMb = if ($null -ne $baselinePssMb -and $null -ne $finalPssMb) { [Math]::Round(([double]$finalPssMb - [double]$baselinePssMb), 1) } else { $null }
$memoryPass = ($null -ne $growthPssMb -and $growthPssMb -le $MaxPssGrowthMb -and $null -ne $finalPssMb -and $finalPssMb -le $MaxFinalPssMb)
$crashCount = @($crashLines -split "`r?`n" | Where-Object { $_.Trim() }).Count
$crashPass = $crashCount -eq 0
$desktopFailures = @($desktopSamples | Where-Object { $_.checked -and -not $_.ok }).Count
$desktopPass = (-not $DesktopBaseUrl) -or $desktopFailures -eq 0
$automaticPass = $memoryPass -and $crashPass -and $desktopPass

$budget = [ordered]@{
  scenario = $Scenario
  librarySize = $LibrarySize
  packageName = $PackageName
  durationMinutes = $DurationMinutes
  thresholds = [ordered]@{
    maxPssGrowthMb = $MaxPssGrowthMb
    maxFinalPssMb = $MaxFinalPssMb
    maxCrashLines = 0
  }
  memory = [ordered]@{
    baselinePssMb = $baselinePssMb
    finalPssMb = $finalPssMb
    peakPssMb = $peakPssMb
    growthPssMb = $growthPssMb
    pass = $memoryPass
    samples = $samples
  }
  crashes = [ordered]@{
    count = $crashCount
    pass = $crashPass
  }
  desktopEndpoint = [ordered]@{
    checked = [bool]$DesktopBaseUrl
    failures = $desktopFailures
    pass = $desktopPass
  }
  trimMemorySent = $trimMemorySent
  automaticPass = $automaticPass
  manualPassRequired = $true
}
Save-Text (Join-Path $runDir "performance-budget.json") ($budget | ConvertTo-Json -Depth 8)

$summary = @"
Wallpaper Player Mobile real-device QA capture

Run directory: $runDir
Package: $PackageName
Scenario: $Scenario
Library size: $LibrarySize
Duration minutes: $DurationMinutes
Desktop endpoint: $DesktopBaseUrl
Skip monkey: $SkipMonkey
Baseline PSS MB: $baselinePssMb
Final PSS MB: $finalPssMb
Peak sampled PSS MB: $peakPssMb
PSS growth MB: $growthPssMb
Memory budget pass: $memoryPass
Crash line count: $crashCount
Crash budget pass: $crashPass
Desktop endpoint failures: $desktopFailures
Desktop endpoint budget pass: $desktopPass
Automatic budget pass: $automaticPass

Manual pass/fail still must be filled using docs/mobile-real-device-qa.md.
"@
Save-Text (Join-Path $runDir "summary.txt") $summary
Write-Step "QA capture saved to $runDir"
