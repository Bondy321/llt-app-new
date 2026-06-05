param(
  [string]$AvdName = "Pixel_8_API_36",
  [int]$BootTimeoutSeconds = 300,
  [switch]$Headless,
  [switch]$ColdBoot
)

$ErrorActionPreference = "Stop"

function Resolve-AndroidSdk {
  $candidates = @(
    $env:ANDROID_SDK_ROOT,
    $env:ANDROID_HOME,
    (Join-Path $env:LOCALAPPDATA "Android\Sdk")
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath (Join-Path $candidate "platform-tools\adb.exe")) {
      return $candidate
    }
  }

  throw "Android SDK not found. Expected adb.exe under ANDROID_SDK_ROOT, ANDROID_HOME, or $env:LOCALAPPDATA\Android\Sdk."
}

$sdk = Resolve-AndroidSdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk

$adb = Join-Path $sdk "platform-tools\adb.exe"
$emulator = Join-Path $sdk "emulator\emulator.exe"

if (!(Test-Path -LiteralPath $emulator)) {
  throw "Android emulator not found at $emulator."
}

& $adb start-server | Out-Null
$deviceLines = & $adb devices | Select-String -Pattern "^emulator-\d+\s+device\b"

if (!$deviceLines) {
  $args = @("-avd", $AvdName, "-no-audio", "-no-boot-anim")

  if ($ColdBoot) {
    $args += "-no-snapshot-load"
  }

  if ($Headless) {
    $args += @("-no-window", "-gpu", "swiftshader_indirect")
    Start-Process -FilePath $emulator -ArgumentList $args -WindowStyle Hidden | Out-Null
  } else {
    $args += @("-gpu", "host")
    Start-Process -FilePath $emulator -ArgumentList $args | Out-Null
  }
}

& $adb wait-for-device

$deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
do {
  $booted = (& $adb shell getprop sys.boot_completed 2>$null).Trim()
  if ($booted -eq "1") {
    break
  }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)

if ($booted -ne "1") {
  throw "Emulator did not finish booting within $BootTimeoutSeconds seconds."
}

& $adb devices -l
$model = (& $adb shell getprop ro.product.model).Trim()
$androidVersion = (& $adb shell getprop ro.build.version.release).Trim()
Write-Host "Android emulator is ready: $model, Android $androidVersion"
