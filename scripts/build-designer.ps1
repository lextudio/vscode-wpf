<#
.SYNOPSIS
    Builds the XamlDesigner tool from the WpfDesigner submodule.

.DESCRIPTION
    Compiles external/WpfDesigner/XamlDesigner/Demo.XamlDesigner.csproj and
    stages the LibreWPF-based designer output in tools/XamlDesigner/.

.PARAMETER Configuration
    MSBuild configuration to use (default: Release).

.PARAMETER TargetFramework
    Target framework to compile for. Defaults to net10.0-windows, matching
    the local LibreWPF.Sdk/11.0.0-dev packages.

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
$BuiltOutputDir  = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\bin\$Configuration\$TargetFramework"

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

Setup-DotnetEnv $DotnetPath

Write-Host ""
Write-Host "=== WPF Designer Tools Build ===" -ForegroundColor Cyan
Write-Host "  Project       : $SubmoduleCsproj"
Write-Host "  Output        : $OutputDir"
Write-Host "  Configuration : $Configuration"
Write-Host "  Framework     : $TargetFramework"
Write-Host "  Dotnet        : $DotnetPath"
Write-Host ""

# Decide which build passes to run based on flags. If no flags provided,
# perform both modern and legacy builds. If -OnlyModern is supplied, only
# build the modern TFM. If -OnlyLegacy is supplied, only build net481.
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

# Create output directory if needed
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$BuiltOutputDir  = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\bin\$Configuration\$TargetFramework"

if ($doModern) {
    Write-Host "  Using LibreWPF.Sdk/11.0.0-dev from the local LibreWPF package feed" -ForegroundColor DarkGray

    Stop-ConflictingDesignerProcesses -RepoRootPath $RepoRoot -BuildOutputPath $OutputDir

    Write-Host ""
    Write-Host "Running: dotnet restore ..." -ForegroundColor Yellow
    & $DotnetPath restore "$SubmoduleCsproj" --nologo -p:UseSharedCompilation=false "-p:XamlDesignerDefaultTargetFramework=$TargetFramework"
    if ($LASTEXITCODE -ne 0) { Write-Error "Restore failed with exit code $LASTEXITCODE."; exit $LASTEXITCODE }

    Write-Host "Running: dotnet build ..." -ForegroundColor Yellow
    & $DotnetPath build "$SubmoduleCsproj" `
        --configuration $Configuration `
        --nologo `
        --no-restore `
        -maxcpucount:1 `
        -p:UseSharedCompilation=false `
        "-p:XamlDesignerDefaultTargetFramework=$TargetFramework"
    if ($LASTEXITCODE -ne 0) { Write-Error "Build failed with exit code $LASTEXITCODE."; exit $LASTEXITCODE }

    # Record the TFM so the extension can check compatibility at launch time
    if (-not (Test-Path $BuiltOutputDir)) {
        Write-Error "Expected built output directory was not found: $BuiltOutputDir"
        exit 1
    }

    Get-ChildItem -Path $OutputDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $BuiltOutputDir '*') -Destination $OutputDir -Recurse -Force
    Set-Content -Path $TfmFile -Value $TargetFramework -Encoding UTF8

    # Report result
    $exe = Join-Path $OutputDir "XamlDesigner.exe"
    $dll = Join-Path $OutputDir "Demo.XamlDesigner.dll"
    Write-Host ""
    if (Test-Path $exe) {
        Write-Host "Build succeeded." -ForegroundColor Green
        Write-Host "  Executable : $exe"
    } elseif (Test-Path $dll) {
        Write-Host "Build succeeded." -ForegroundColor Green
        Write-Host "  Assembly   : $dll"
    } else {
        Write-Warning "Build completed but expected outputs were not found in $OutputDir."
    }
}

# ---------------------------------------------------------------------------
# Optional Windows-only legacy designer for net4x project support.
# ---------------------------------------------------------------------------
$LegacyTfm       = "net481"
$LegacyOutputDir = Join-Path $RepoRoot "tools\XamlDesignerLegacy"
$LegacyBuiltDir  = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\bin\$Configuration\$LegacyTfm"

Write-Host ""
Write-Host "=== Building .NET Framework Designer ($LegacyTfm) ===" -ForegroundColor Cyan

if (-not $doLegacy) {
    Write-Host "Skipping $LegacyTfm designer on this platform." -ForegroundColor DarkGray
    exit 0
}

if (-not (Test-Path $LegacyOutputDir)) {
    New-Item -ItemType Directory -Path $LegacyOutputDir | Out-Null
}

Write-Host "  Using committed external/WpfDesigner/Directory.Build.props; passing XamlDesignerDefaultTargetFramework=net481" -ForegroundColor DarkGray

$legacyOk = $false
try {
    & dotnet restore "$SubmoduleCsproj" --nologo -p:UseSharedCompilation=false "-p:XamlDesignerDefaultTargetFramework=$LegacyTfm" "-p:EnableWindowsTargeting=true" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Restore failed" }

    & dotnet build "$SubmoduleCsproj" `
        --configuration $Configuration `
        --nologo `
        --no-restore `
        -maxcpucount:1 `
        -p:UseSharedCompilation=false `
        "-p:XamlDesignerDefaultTargetFramework=$LegacyTfm" "-p:EnableWindowsTargeting=true" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }

    if (-not (Test-Path $LegacyBuiltDir)) { throw "Output directory not found" }

    Get-ChildItem -Path $LegacyOutputDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $LegacyBuiltDir '*') -Destination $LegacyOutputDir -Recurse -Force
    $legacyOk = $true
}
catch {
    Write-Error "net481 designer build failed: $_"
}

if ($legacyOk) {
    $legacyExe = Join-Path $LegacyOutputDir "XamlDesigner.exe"
    $legacyTfmFile = Join-Path $LegacyOutputDir "designer.tfm"
    Set-Content -Path $legacyTfmFile -Value $LegacyTfm -Encoding UTF8
    Write-Host "$LegacyTfm designer built." -ForegroundColor Green
    Write-Host "  Executable : $legacyExe"
} else {
    Write-Error "Required net481 designer build did not produce output. Install the .NET Framework 4.8.1 targeting pack/developer pack and retry."
    exit 1
}
