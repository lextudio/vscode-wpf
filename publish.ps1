Param(
	[switch]$Publish
)

Set-StrictMode -Version Latest
$here = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $here

Write-Host 'Building extension (esbuild)...'
Write-Host 'Syncing package.json version from latest git tag (if present)...'
.\update-version.ps1

Write-Host 'Building extension (esbuild)...'
npm run build

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$vsixName = "$($pkg.name)-$($pkg.version).vsix"

Write-Host "Packaging .vsix as $vsixName..."
npx -y vsce package --out $vsixName

Write-Host "Created $vsixName"

if ($Publish) {
	Write-Host "Publishing $vsixName to Marketplace (requires vsce login)..."
	npx -y vsce publish
}
