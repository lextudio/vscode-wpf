<#
.SYNOPSIS
    Builds the XamlDesigner tool from the WpfDesigner submodule.

.DESCRIPTION
    Compiles external/WpfDesigner/XamlDesigner/Demo.XamlDesigner.csproj and
    stages the LibreWPF-based designer output in tools/XamlDesigner/.

.PARAMETER Configuration
    MSBuild configuration to use (default: Release).

.PARAMETER TargetFramework
    Modern (cross-platform) target framework to compile for. Defaults to
    net10.0-windows, matching the LibreWPF.Sdk packages.

.EXAMPLE
    .\scripts\build-designer.ps1
    .\scripts\build-designer.ps1 -TargetFramework net10.0-windows
    .\scripts\build-designer.ps1 -Configuration Debug
#>
param(
    [string]$Configuration   = "Release",
    [string]$TargetFramework = "",
    [string]$DotnetPath      = "",
    [switch]$OnlyModern,
    [switch]$OnlyLegacy
)

$ErrorActionPreference = "Stop"

$RepoRoot        = Split-Path -Parent $PSScriptRoot
$SubmoduleCsproj = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\Demo.XamlDesigner.csproj"
$SubmoduleRoot   = Join-Path $RepoRoot "external\WpfDesigner"
$OutputDir       = Join-Path $RepoRoot "tools\XamlDesigner"
$TfmFile         = Join-Path $OutputDir "designer.tfm"

# Verify submodule is initialised
if (-not (Test-Path $SubmoduleCsproj)) {
    Write-Error @"
WpfDesigner submodule not found at:
  $SubmoduleCsproj

Initialise it first:
  git submodule update --init --recursive
"@
    exit 1
}

if (-not $DotnetPath -or -not (Test-Path $DotnetPath)) {
    $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($dotnetCommand) {
        $DotnetPath = $dotnetCommand.Source
    }
}

if (-not (Test-Path $DotnetPath)) {
    Write-Error "dotnet CLI not found. Install .NET 10 SDK or pass -DotnetPath."
    exit 1
}

function Setup-DotnetEnv {
    param([string]$Dotnet)

    $dotnetBinDir = Split-Path -Parent $Dotnet
    if (Test-Path (Join-Path $dotnetBinDir "sdk")) {
        $env:DOTNET_ROOT = $dotnetBinDir
    } elseif (Test-Path (Join-Path $dotnetBinDir "..\libexec\sdk")) {
        $env:DOTNET_ROOT = (Resolve-Path (Join-Path $dotnetBinDir "..\libexec")).Path
    } else {
        return
    }

    $env:DOTNET_HOST_PATH = $Dotnet
    $sdkDir = Get-ChildItem -Path (Join-Path $env:DOTNET_ROOT "sdk") -Directory | Sort-Object Name | Select-Object -Last 1
    if ($sdkDir) {
        $env:MSBuildSDKsPath = Join-Path $sdkDir.FullName "Sdks"
        $env:MSBuildExtensionsPath = $sdkDir.FullName
        $env:MSBUILDADDITIONALSDKRESOLVERSFOLDER_NET = Join-Path $sdkDir.FullName "SdkResolvers"
        $env:MSBUILD_NUGET_PATH = $sdkDir.FullName
        $env:MSBuildEnableWorkloadResolver = "false"
    }
}

function Stop-ConflictingDesignerProcesses {
    param(
        [string]$RepoRootPath,
        [string]$BuildOutputPath
    )

    try {
        & $DotnetPath build-server shutdown | Out-Null
    } catch {
        # Best effort only.
    }

    if (-not $IsWindows) {
        return
    }

    $lockingNames = @(
        'VBCSCompiler.exe',
        'XamlDesigner.exe',
        'Demo.XamlDesigner.exe'
    )

    $repoPattern = [regex]::Escape($RepoRootPath)
    $outputPattern = [regex]::Escape($BuildOutputPath)

    try {
        $candidates = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
            $name = $_.Name
            if ($lockingNames -contains $name) {
                return $true
            }

            if ($name -in @('MSBuild.exe', 'dotnet.exe') -and $_.CommandLine) {
                return $_.CommandLine -match $repoPattern -or $_.CommandLine -match $outputPattern -or $_.CommandLine -match 'WpfDesigner' -or $_.CommandLine -match 'XamlDesigner'
            }

            return $false
        }

        foreach ($proc in $candidates) {
            Write-Host "  Killing lock-holder: $($proc.Name) (pid $($proc.ProcessId))" -ForegroundColor DarkYellow
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Warning "Could not inspect or kill conflicting processes: $($_.Exception.Message)"
    }
}

if (-not $TargetFramework) {
    $TargetFramework = 'net10.0-windows'
    Write-Host "  TargetFramework : $TargetFramework (default for LibreWPF)" -ForegroundColor DarkGray
} else {
    Write-Host "  TargetFramework : $TargetFramework (explicit)" -ForegroundColor DarkGray
}

$LegacyTfm       = "net481"
$LegacyOutputDir = Join-Path $RepoRoot "tools\XamlDesignerLegacy"

# Decide which TFMs to build based on flags. If no flags provided, build
# both modern (net10.0-windows) and legacy (net481) in a single multi-target
# restore/build — Directory.Build.props sets TargetFrameworks accordingly.
# If -OnlyModern/-OnlyLegacy is supplied, restrict to a single TFM.
if ($OnlyModern) {
    $doModern = $true
    $doLegacy = $false
}
elseif ($OnlyLegacy) {
    $doModern = $false
    $doLegacy = $true
}
else {
    $doModern = $true
    $doLegacy = $IsWindows
}

$tfms = @()
if ($doModern) { $tfms += $TargetFramework }
if ($doLegacy) { $tfms += $LegacyTfm }
$TargetFrameworksArg = [string]::Join(';', $tfms)

Setup-DotnetEnv $DotnetPath

Write-Host ""
Write-Host "=== WPF Designer Tools Build ===" -ForegroundColor Cyan
Write-Host "  Project        : $SubmoduleCsproj"
Write-Host "  Configuration  : $Configuration"
Write-Host "  TargetFrameworks : $TargetFrameworksArg"
Write-Host "  Dotnet         : $DotnetPath"
Write-Host ""

if (-not $tfms.Count) {
    Write-Host "Nothing to build for this platform/flag combination." -ForegroundColor DarkGray
    exit 0
}

# Create output directories if needed
if ($doModern -and -not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}
if ($doLegacy -and -not (Test-Path $LegacyOutputDir)) {
    New-Item -ItemType Directory -Path $LegacyOutputDir | Out-Null
}

Stop-ConflictingDesignerProcesses -RepoRootPath $RepoRoot -BuildOutputPath $OutputDir

Write-Host "Running: dotnet restore ..." -ForegroundColor Yellow
& $DotnetPath restore "$SubmoduleCsproj" --nologo --force -p:UseSharedCompilation=false "-p:XamlDesignerDefaultTargetFrameworks=$TargetFrameworksArg" "-p:EnableWindowsTargeting=true"
if ($LASTEXITCODE -ne 0) { Write-Error "Restore failed with exit code $LASTEXITCODE."; exit $LASTEXITCODE }

Write-Host "Running: dotnet build ..." -ForegroundColor Yellow
& $DotnetPath build "$SubmoduleCsproj" `
    --configuration $Configuration `
    --nologo `
    --no-restore `
    -maxcpucount:1 `
    -p:UseSharedCompilation=false `
    "-p:XamlDesignerDefaultTargetFrameworks=$TargetFrameworksArg" `
    "-p:EnableWindowsTargeting=true"
if ($LASTEXITCODE -ne 0) { Write-Error "Build failed with exit code $LASTEXITCODE."; exit $LASTEXITCODE }

function Publish-DesignerOutput {
    param(
        [string]$Tfm,
        [string]$Destination,
        [string]$TfmFilePath
    )

    $builtDir = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\bin\$Configuration\$Tfm"
    if (-not (Test-Path $builtDir)) {
        Write-Error "Expected built output directory was not found: $builtDir"
        exit 1
    }

    Get-ChildItem -Path $Destination -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $builtDir '*') -Destination $Destination -Recurse -Force
    Set-Content -Path $TfmFilePath -Value $Tfm -Encoding UTF8

    $exe = Join-Path $Destination "Demo.XamlDesigner.exe"
    $dll = Join-Path $Destination "Demo.XamlDesigner.dll"
    Write-Host ""
    if (Test-Path $exe) {
        Write-Host "$Tfm build succeeded." -ForegroundColor Green
        Write-Host "  Executable : $exe"
    } elseif (Test-Path $dll) {
        Write-Host "$Tfm build succeeded." -ForegroundColor Green
        Write-Host "  Assembly   : $dll"
    } else {
        Write-Warning "$Tfm build completed but expected outputs were not found in $Destination."
    }
}

if ($doModern) {
    Publish-DesignerOutput -Tfm $TargetFramework -Destination $OutputDir -TfmFilePath $TfmFile
}

if ($doLegacy) {
    $legacyTfmFile = Join-Path $LegacyOutputDir "designer.tfm"
    Publish-DesignerOutput -Tfm $LegacyTfm -Destination $LegacyOutputDir -TfmFilePath $legacyTfmFile
}
