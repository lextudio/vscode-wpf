<#
.SYNOPSIS
    Builds the XamlDesigner tool from the WpfDesigner submodule.

.DESCRIPTION
    Compiles external/WpfDesigner/XamlDesigner/Demo.XamlDesigner.csproj in
    Release mode and places the output in tools/XamlDesigner/.  The tools/
    directory is included in the VSIX package so the designer ships with the
    extension.

.PARAMETER Configuration
    MSBuild configuration to use (default: Release).

.EXAMPLE
    .\scripts\build-designer.ps1
    .\scripts\build-designer.ps1 -Configuration Debug
#>
param(
    [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$SubmoduleCsproj = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\Demo.XamlDesigner.csproj"
$OutputDir  = Join-Path $RepoRoot "tools\XamlDesigner"

Write-Host ""
Write-Host "=== WPF Designer Tools Build ===" -ForegroundColor Cyan
Write-Host "  Project       : $SubmoduleCsproj"
Write-Host "  Output        : $OutputDir"
Write-Host "  Configuration : $Configuration"
Write-Host ""

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

# Ensure dotnet CLI is available
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "dotnet CLI not found on PATH.  Install the .NET SDK from https://dot.net"
    exit 1
}

# Create output directory if needed
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

Write-Host "Running: dotnet build ..." -ForegroundColor Yellow
& dotnet build `"$SubmoduleCsproj`" --configuration $Configuration --output `"$OutputDir`" --nologo
$exit = $LASTEXITCODE
if ($exit -ne 0) {
    Write-Error "Build failed with exit code $exit."
    exit $exit
}

# Check for produced outputs. Some projects produce DLLs rather than an EXE.
$exe = Join-Path $OutputDir "XamlDesigner.exe"
$dll = Join-Path $OutputDir "Demo.XamlDesigner.dll"
if (Test-Path $exe) {
    Write-Host ""; Write-Host "Build succeeded." -ForegroundColor Green
    Write-Host "  Designer executable: $exe"
} elseif (Test-Path $dll) {
    Write-Host ""; Write-Host "Build succeeded." -ForegroundColor Green
    Write-Host "  Designer assembly: $dll"
} else {
    Write-Warning "Build completed but expected outputs were not found in $OutputDir."
    # Not treating as fatal in case project layout differs; still return success code 0
}
