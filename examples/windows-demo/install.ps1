# install.ps1 — Bootstrap and build windows-demo with static JS bundle
#
# Usage (from PowerShell):
#   cd examples\windows-demo
#   powershell -ExecutionPolicy Bypass -File install.ps1
#
# Or from WSL:
#   powershell.exe -ExecutionPolicy Bypass -File 'D:\rill\examples\windows-demo\install.ps1'
#
# Prerequisites:
#   - Node.js >= 18
#   - Visual Studio 2022 with Desktop C++ and UWP workloads
#   - Windows 10/11 SDK
#   - Developer Mode enabled (Settings > System > For developers)

$ErrorActionPreference = "Stop"

# Ensure we're in the right directory
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $scriptDir

Write-Host "`n=== Rill Windows Demo Setup ===`n" -ForegroundColor Cyan

# 1. Check Node.js
Write-Host "[1/5] Checking Node.js..." -ForegroundColor Yellow
$nodeVersion = node --version 2>$null
if (-not $nodeVersion) {
    Write-Host "  ERROR: Node.js not found. Install via: winget install OpenJS.NodeJS.LTS" -ForegroundColor Red
    exit 1
}
Write-Host "  Node.js $nodeVersion" -ForegroundColor Green

# 2. Install npm dependencies
Write-Host "[2/5] Installing npm dependencies..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: npm install failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Dependencies installed" -ForegroundColor Green

# 3. Bundle JavaScript (static — no Metro dev server needed)
Write-Host "[3/5] Bundling JavaScript..." -ForegroundColor Yellow
$bundleDir = Join-Path $scriptDir "windows\WindowsDemo.Package\Bundle"
if (-not (Test-Path $bundleDir)) {
    New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null
}
npx react-native bundle `
    --entry-file index.js `
    --platform windows `
    --dev false `
    --bundle-output "$bundleDir\index.windows.bundle" `
    --assets-dest "$bundleDir"
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: JS bundle failed" -ForegroundColor Red
    exit 1
}
Write-Host "  JS bundle created" -ForegroundColor Green

# 4. Build solution
Write-Host "[4/5] Building solution..." -ForegroundColor Yellow
$msbuild = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
    -latest -requires Microsoft.Component.MSBuild `
    -find MSBuild\**\Bin\MSBuild.exe 2>$null | Select-Object -First 1
if (-not $msbuild) {
    Write-Host "  ERROR: MSBuild not found. Install Visual Studio 2022 with Desktop C++ workload." -ForegroundColor Red
    exit 1
}
$slnPath = Join-Path $scriptDir "windows\WindowsDemo.sln"
& $msbuild $slnPath /p:Configuration=Debug /p:Platform=x64 /restore /m
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: Build failed" -ForegroundColor Red
    exit 1
}
Write-Host "  Build complete" -ForegroundColor Green

# 5. Deploy (register loose layout)
Write-Host "[5/5] Deploying..." -ForegroundColor Yellow

# Copy bundle to layout next to the exe
# Note: manifest is at bin\x64\Debug\AppxManifest.xml (NOT in AppX\ subdirectory)
$layoutDir = Join-Path $scriptDir "windows\WindowsDemo.Package\bin\x64\Debug"
$layoutBundleDir = Join-Path $layoutDir "WindowsDemo\Bundle"
if (-not (Test-Path $layoutBundleDir)) {
    New-Item -ItemType Directory -Path $layoutBundleDir -Force | Out-Null
}
Copy-Item "$bundleDir\index.windows.bundle" "$layoutBundleDir\index.windows.bundle" -Force

# Copy Images into layout root (required by AppxManifest)
$pkgImages = Join-Path $scriptDir "windows\WindowsDemo.Package\Images"
if (Test-Path $pkgImages) {
    $layoutImages = Join-Path $layoutDir "Images"
    if (-not (Test-Path $layoutImages)) {
        New-Item -ItemType Directory -Path $layoutImages -Force | Out-Null
    }
    Copy-Item "$pkgImages\*" $layoutImages -Force
}

# Remove old installation if present
$existing = Get-AppxPackage -Name "*WindowsDemo*" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  Removing previous installation..." -ForegroundColor Yellow
    $existing | Remove-AppxPackage -ErrorAction SilentlyContinue
}

# Register loose layout (no signing needed for dev)
$manifestPath = Join-Path $layoutDir "AppxManifest.xml"
Add-AppxPackage -Register $manifestPath
Write-Host "  Deployed" -ForegroundColor Green

# Launch
Write-Host "`nLaunching app..." -ForegroundColor Cyan
$pfn = (Get-AppxPackage -Name "*WindowsDemo*").PackageFamilyName
explorer.exe "shell:AppsFolder\$pfn!App"

Write-Host "`n=== Setup Complete ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "The JS bundle is pre-built into the app." -ForegroundColor Green
Write-Host "No Metro dev server needed." -ForegroundColor Green
Write-Host ""
Write-Host "To re-bundle and rebuild after code changes:" -ForegroundColor Yellow
Write-Host "  npm run bundle    # Re-bundle JS" -ForegroundColor White
Write-Host "  npm run windows   # Rebuild and deploy" -ForegroundColor White
Write-Host ""
