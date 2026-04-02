Param(
	[switch]$Publish
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $here

$targets = @(
	'win32-x64',
	'win32-arm64'
)

Write-Host 'Removing old .vsix files from destination folder...'
Get-ChildItem -Path $here -Filter *.vsix -File | Remove-Item -Force

Write-Host 'Syncing package.json version from latest git tag (if present)...'
.\update-version.ps1

Write-Host 'Building extension (esbuild)...'
npm run build

Write-Host 'Building packaged XamlDesigner variants (modern + net481)...'
powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'scripts\build-designer.ps1') -Configuration Release
if ($LASTEXITCODE -ne 0) { throw 'Failed to build XamlDesigner variants' }

Write-Host 'Building WpfHotReload.Runtime helper (netcoreapp3.0 + net462)...'
$helperProj = Join-Path $here 'src\WpfHotReload.Runtime\WpfHotReload.Runtime.csproj'
foreach ($tfm in @('netcoreapp3.0', 'net462')) {
	$outDir = Join-Path $here "tools\WpfHotReload.Runtime\$tfm\"
	dotnet build $helperProj -c Release -f $tfm -nologo "-p:OutDir=$outDir"
	if ($LASTEXITCODE -ne 0) { throw "Failed to build WpfHotReload.Runtime for $tfm" }
}

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$createdVsix = @()

foreach ($target in $targets) {
	$vsixName = "$($pkg.name)-$($pkg.version)-$target.vsix"

	Write-Host "Packaging .vsix for $target as $vsixName..."
	npx -y vsce package --target $target --out $vsixName
	$createdVsix += $vsixName
	Write-Host "Created $vsixName"
}

if ($Publish) {
	foreach ($target in $targets) {
		Write-Host "Publishing $($pkg.name) for $target to Marketplace (requires vsce login)..."
		npx -y vsce publish --target $target
	}
}

Write-Host ''
Write-Host 'Packaging complete:'
foreach ($vsix in $createdVsix) {
	Write-Host "  $vsix"
}
