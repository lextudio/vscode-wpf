Param(
	[switch]$Publish,
	[ValidateSet('win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64', '')]
	[string]$Target = '',
	[switch]$All,
	[string]$RuntimeIdentifier = '',
	[string]$PlatformTarget = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $here

# RID drives .NET Core apphost bitness (XamlDesigner modern, language server, analyzer).
# Deriving it from the vsce target lets the author cross-publish locally: e.g. building
# win32-x64 on an ARM machine still emits x64 apphosts.
$targetToRid = @{
	'win32-x64'    = 'win-x64'
	'win32-arm64'  = 'win-arm64'
	'darwin-x64'   = 'osx-x64'
	'darwin-arm64' = 'osx-arm64'
	'linux-x64'    = 'linux-x64'
	'linux-arm64'  = 'linux-arm64'
}

# PlatformTarget drives the net481 (.NET Framework) designer bitness, where RID is not meaningful.
$targetToPlatformTarget = @{
	'win32-x64'   = 'x64'
	'win32-arm64' = 'ARM64'
}

$allTargets = @('win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64')

if ($All -and $Target) {
	throw 'Specify either -All or -Target, not both.'
}

function Get-RidArgs {
	param([string]$Rid)
	if ($Rid) { return @('-r', $Rid) }
	return @()
}

function Get-PlatformTargetArgs {
	param([string]$Cpu)
	if ($Cpu) { return @("-p:PlatformTarget=$Cpu") }
	return @()
}

function Build-Target {
	param(
		[string]$Tgt,
		[string]$Rid,
		[string]$Cpu
	)

	$isWindowsTarget = $Tgt -match '^win32-'
	$buildWindowsTools = (-not $Tgt) -or $isWindowsTarget

	if ($buildWindowsTools) {
		Write-Host "Building packaged XamlDesigner variants (modern RID '$Rid' / net481 PlatformTarget '$Cpu')..."
		$designerArgs = @(
			'-NoProfile', '-ExecutionPolicy', 'Bypass',
			'-File', (Join-Path $here 'scripts\build-designer.ps1'),
			'-Configuration', 'Release'
		)
		if ($Rid) { $designerArgs += @('-RuntimeIdentifier', $Rid) }
		if ($Cpu) { $designerArgs += @('-PlatformTarget', $Cpu) }
		pwsh @designerArgs
		if ($LASTEXITCODE -ne 0) { throw 'Failed to build XamlDesigner variants' }

		# Hot reload helper is an AnyCPU library injected into the user's process; no arch override.
		Write-Host 'Building WpfHotReload.Runtime helper (netcoreapp3.0 + net462)...'
		$helperProj = Join-Path $here 'src\WpfHotReload.Runtime\WpfHotReload.Runtime.csproj'
		foreach ($tfm in @('netcoreapp3.0', 'net462')) {
			$outDir = Join-Path $here "tools\WpfHotReload.Runtime\$tfm\"
			dotnet build $helperProj -c Release -f $tfm -nologo "-p:OutDir=$outDir" '-p:EnableWindowsTargeting=true'
			if ($LASTEXITCODE -ne 0) { throw "Failed to build WpfHotReload.Runtime for $tfm" }
		}

		Write-Host 'Building XAML Language Server...'
		$lsProj = Join-Path $here 'src\XamlLanguageServer.Wpf\XamlLanguageServer.Wpf.csproj'
		$lsOut = Join-Path $here 'tools\XamlLanguageServer'
		$lsArgs = @('publish', $lsProj, '-c', 'Release', '--output', $lsOut, '--no-self-contained')
		$lsArgs += Get-RidArgs -Rid $Rid
		dotnet @lsArgs
		if ($LASTEXITCODE -ne 0) { throw 'Failed to build XamlLanguageServer' }
	}

	Write-Host 'Building WPF Project Analyzer...'
	$analyzerProj = Join-Path $here 'src\WpfProjectAnalyzer\WpfProjectAnalyzer.csproj'
	$analyzerOut = Join-Path $here 'tools\WpfProjectAnalyzer'
	$analyzerArgs = @('publish', $analyzerProj, '-c', 'Release', '--output', $analyzerOut, '--no-self-contained')
	$analyzerArgs += Get-RidArgs -Rid $Rid
	dotnet @analyzerArgs
	if ($LASTEXITCODE -ne 0) { throw 'Failed to build WpfProjectAnalyzer' }

	if ($Tgt) {
		$vsixName = "$($script:pkgName)-$($script:pkgVersion)-$Tgt.vsix"
		Write-Host "Packaging platform-specific .vsix as $vsixName (target: $Tgt)..."
		npx -y "@vscode/vsce" package --target $Tgt --out $vsixName
	}
	else {
		$vsixName = "$($script:pkgName)-$($script:pkgVersion).vsix"
		Write-Host "Packaging generic .vsix as $vsixName..."
		npx -y "@vscode/vsce" package --out $vsixName
	}
	if ($LASTEXITCODE -ne 0) { throw 'Failed to create .vsix package' }
	Write-Host "Created $vsixName"

	if ($Publish) {
		Write-Host "Publishing $($script:pkgName) to Marketplace (requires vsce login or VSCE_PAT)..."
		if ($Tgt) {
			npx -y "@vscode/vsce" publish --packagePath $vsixName
		}
		else {
			npx -y "@vscode/vsce" publish
		}
		if ($LASTEXITCODE -ne 0) { throw 'Failed to publish .vsix to Marketplace' }
	}

	return $vsixName
}

Write-Host 'Removing old .vsix files from destination folder...'
Get-ChildItem -Path $here -Filter *.vsix -File | Remove-Item -Force

Write-Host 'Syncing package.json version from latest git tag (if present)...'
.\update-version.ps1

Write-Host 'Building extension (esbuild)...'
npm run build

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$script:pkgName = $pkg.name
$script:pkgVersion = $pkg.version
$createdVsix = @()

if ($All) {
	foreach ($t in $allTargets) {
		$rid = $targetToRid[$t]
		$cpu = if ($targetToPlatformTarget.ContainsKey($t)) { $targetToPlatformTarget[$t] } else { '' }
		$createdVsix += Build-Target -Tgt $t -Rid $rid -Cpu $cpu
	}
}
else {
	if ($Target -and -not $RuntimeIdentifier) {
		$RuntimeIdentifier = $targetToRid[$Target]
	}
	if ($Target -and -not $PlatformTarget -and $targetToPlatformTarget.ContainsKey($Target)) {
		$PlatformTarget = $targetToPlatformTarget[$Target]
	}
	$createdVsix += Build-Target -Tgt $Target -Rid $RuntimeIdentifier -Cpu $PlatformTarget
}

Write-Host ''
Write-Host 'Packaging complete:'
foreach ($vsix in $createdVsix) {
	Write-Host "  $vsix"
}
