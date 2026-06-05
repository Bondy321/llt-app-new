param(
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$workspaceRoot = Resolve-Path (Join-Path $projectRoot "..")
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$adb = Join-Path $sdk "platform-tools\adb.exe"

if (!(Test-Path -LiteralPath $adb)) {
  throw "adb.exe not found at $adb."
}

if (!$OutputPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path $workspaceRoot "screens\android-emulator-$stamp.png"
}

$outputDir = Split-Path -Parent $OutputPath
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

$remotePath = "/sdcard/codex-android-screenshot.png"
& $adb shell screencap -p $remotePath
& $adb pull $remotePath $OutputPath | Out-Null
& $adb shell rm $remotePath

$resolved = Resolve-Path $OutputPath
Write-Host "Screenshot captured: $resolved"
