param(
  [int]$Port = 8082,
  [switch]$Build,
  [switch]$HeadlessEmulator
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } elseif ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA "Android\Sdk" }
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "C:\Program Files\Android\Android Studio\jbr" }
$env:EXPO_NO_TELEMETRY = "1"

$androidPathEntries = @(
  (Join-Path $sdk "platform-tools"),
  (Join-Path $sdk "emulator"),
  (Join-Path $sdk "cmdline-tools\latest\bin")
)
$env:PATH = ($androidPathEntries + @($env:PATH)) -join ";"

$node = "C:\Program Files\nodejs\node.exe"
if (!(Test-Path -LiteralPath $node)) {
  $nodeCommand = Get-Command node -ErrorAction Stop
  $node = $nodeCommand.Source
}

$expoCli = Join-Path $projectRoot "node_modules\expo\bin\cli"
$adb = Join-Path $sdk "platform-tools\adb.exe"

if (!(Test-Path -LiteralPath $expoCli)) {
  throw "Expo CLI not found under node_modules. Run npm install first."
}

$emulatorArgs = @()
if ($HeadlessEmulator) {
  $emulatorArgs += "-Headless"
}
& (Join-Path $PSScriptRoot "android-emulator.ps1") @emulatorArgs

$packageInstalled = (& $adb shell pm list packages com.lochlomondtravel.tourapp) -match "com\.lochlomondtravel\.tourapp"
if ($Build -or !$packageInstalled) {
  Push-Location $projectRoot
  try {
    & $node $expoCli run:android --no-bundler
  } finally {
    Pop-Location
  }
}

Push-Location $projectRoot
try {
  & $node $expoCli start --dev-client --android --port $Port
} finally {
  Pop-Location
}
