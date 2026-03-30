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

Write-Host 'Syncing package.json version from latest git tag (if present)...'
.\update-version.ps1

Write-Host 'Building extension (esbuild)...'
npm run build

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
