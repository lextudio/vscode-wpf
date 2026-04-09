Param(
	[switch]$Publish
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $here

# Build a single generic .vsix for all platforms (no platform-specific targets)
# Previously we created platform-specific vsix packages; now produce one package.
# Keep the $targets variable empty for compatibility with older scripts.
$targets = @()

Write-Host 'Removing old .vsix files from destination folder...'
Get-ChildItem -Path $here -Filter *.vsix -File | Remove-Item -Force

Write-Host 'Syncing package.json version from latest git tag (if present)...'
.\update-version.ps1

Write-Host 'Building extension (esbuild)...'
npm run build

Write-Host 'Building packaged XamlDesigner variants (modern + net481)...'
pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'scripts\build-designer.ps1') -Configuration Release
if ($LASTEXITCODE -ne 0) { throw 'Failed to build XamlDesigner variants' }

Write-Host 'Building WpfHotReload.Runtime helper (netcoreapp3.0 + net462)...'
$helperProj = Join-Path $here 'src\WpfHotReload.Runtime\WpfHotReload.Runtime.csproj'
foreach ($tfm in @('netcoreapp3.0', 'net462')) {
	$outDir = Join-Path $here "tools\WpfHotReload.Runtime\$tfm\"
	 # EnableWindowsTargeting is required when building Windows-targeting TFMs on macOS/Linux
	 dotnet build $helperProj -c Release -f $tfm -nologo "-p:OutDir=$outDir" "-p:EnableWindowsTargeting=true"
	if ($LASTEXITCODE -ne 0) { throw "Failed to build WpfHotReload.Runtime for $tfm" }
}

Write-Host 'Building XAML Language Server...'
$lsProj = Join-Path $here 'src\XamlLanguageServer.Wpf\XamlLanguageServer.Wpf.csproj'
$lsOut = Join-Path $here 'tools\XamlLanguageServer'
dotnet publish $lsProj -c Release --output $lsOut --no-self-contained
if ($LASTEXITCODE -ne 0) { throw 'Failed to build XamlLanguageServer' }

Write-Host 'Building WPF Project Analyzer...'
$analyzerProj = Join-Path $here 'src\WpfProjectAnalyzer\WpfProjectAnalyzer.csproj'
$analyzerOut = Join-Path $here 'tools\WpfProjectAnalyzer'
dotnet publish $analyzerProj -c Release --output $analyzerOut --no-self-contained
if ($LASTEXITCODE -ne 0) { throw 'Failed to build WpfProjectAnalyzer' }

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$createdVsix = @()

# Create one generic .vsix for all platforms
$vsixName = "$($pkg.name)-$($pkg.version).vsix"
Write-Host "Packaging generic .vsix as $vsixName..."
npx -y vsce package --out $vsixName
if ($LASTEXITCODE -ne 0) { throw 'Failed to create .vsix package' }
$createdVsix += $vsixName
Write-Host "Created $vsixName"

if ($Publish) {
	Write-Host "Publishing $($pkg.name) to Marketplace (requires vsce login)..."
	npx -y vsce publish
	if ($LASTEXITCODE -ne 0) { throw 'Failed to publish .vsix to Marketplace' }
}

Write-Host ''
Write-Host 'Packaging complete:'
foreach ($vsix in $createdVsix) {
	Write-Host "  $vsix"
}
