<#
.SYNOPSIS
    Builds the XamlDesigner tool from the WpfDesigner submodule.

.DESCRIPTION
    Compiles external/WpfDesigner/XamlDesigner/Demo.XamlDesigner.csproj and
    stages the modern designer output in tools/XamlDesigner/ and the
    .NET Framework 4.8.1 output in tools/XamlDesignerLegacy/.

    To override the TargetFramework for all projects in the submodule without
    modifying any source file, the script temporarily writes a
    Directory.Build.props in external/WpfDesigner/ and removes it when done.
    MSBuild searches for Directory.Build.props upward from each project file,
    so every project in the submodule inherits the override consistently during
    both restore and build.

.PARAMETER Configuration
    MSBuild configuration to use (default: Release).

.PARAMETER TargetFramework
    Target framework to compile for. Leave empty to auto-detect the highest
    installed .NET Windows SDK.
    Override only when pinning to a specific version, e.g. net10.0-windows.

.EXAMPLE
    .\scripts\build-designer.ps1
    .\scripts\build-designer.ps1 -TargetFramework net10.0-windows
    .\scripts\build-designer.ps1 -Configuration Debug
#>
param(
    [string]$Configuration   = "Release",
    [string]$TargetFramework = "",
    [switch]$OnlyModern,
    [switch]$OnlyLegacy
)

$ErrorActionPreference = "Stop"

$RepoRoot        = Split-Path -Parent $PSScriptRoot
$SubmoduleCsproj = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\Demo.XamlDesigner.csproj"
$SubmoduleRoot   = Join-Path $RepoRoot "external\WpfDesigner"
$OutputDir       = Join-Path $RepoRoot "tools\XamlDesigner"
$TfmFile         = Join-Path $OutputDir "designer.tfm"
$TempProps       = Join-Path $SubmoduleRoot "Directory.Build.props"
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

# Ensure dotnet CLI is available
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) {
    Write-Error "dotnet CLI not found on PATH.  Install the .NET SDK from https://dot.net"
    exit 1
}

function Stop-ConflictingDesignerProcesses {
    param(
        [string]$RepoRootPath,
        [string]$BuildOutputPath
    )

    try {
        & dotnet build-server shutdown | Out-Null
    } catch {
        # Best effort only.
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

# Auto-detect highest installed .NET SDK when TargetFramework not specified
if (-not $TargetFramework) {
    $sdkList = & dotnet --list-sdks 2>$null
    $highest = $sdkList |
        ForEach-Object { if ($_ -match '^(\d+)\.\d+\.\d+') { [int]$Matches[1] } } |
        Where-Object { $_ -ge 5 } |
        Sort-Object -Descending |
        Select-Object -First 1
    $TargetFramework = if ($highest) { "net${highest}.0-windows" } else { "net10.0-windows" }
    Write-Host "  TargetFramework : $TargetFramework (auto-detected)" -ForegroundColor DarkGray
} else {
    Write-Host "  TargetFramework : $TargetFramework (explicit)" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "=== WPF Designer Tools Build ===" -ForegroundColor Cyan
Write-Host "  Project       : $SubmoduleCsproj"
Write-Host "  Output        : $OutputDir"
Write-Host "  Configuration : $Configuration"
Write-Host "  Framework     : $TargetFramework"
Write-Host ""

# Decide which build passes to run based on flags. If no flags provided,
# perform both modern and legacy builds. If -OnlyModern is supplied, only
# build the modern TFM. If -OnlyLegacy is supplied, only build net481.
if ($OnlyModern -and $OnlyLegacy) {
    $doModern = $true
    $doLegacy = $true
}
elseif ($OnlyModern) {
    $doModern = $true
    $doLegacy = $false
}
elseif ($OnlyLegacy) {
    $doModern = $false
    $doLegacy = $true
}
else {
    $doModern = $true
    $doLegacy = $true
}

# Create output directory if needed
if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$BuiltOutputDir  = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\bin\$Configuration\$TargetFramework"

if ($doModern) {
    # Write a temporary Directory.Build.props so every project in the submodule
    # inherits the same TargetFramework during restore AND build — no csproj edits needed.
    $propsContent = @"
<!-- Auto-generated by build-designer.ps1 — do not commit -->
<Project>
    <PropertyGroup>
        <TargetFramework>$TargetFramework</TargetFramework>
        <EnableWindowsTargeting>true</EnableWindowsTargeting>
    </PropertyGroup>
</Project>
"@
    Set-Content -Path $TempProps -Value $propsContent -Encoding UTF8
    Write-Host "  Wrote temporary Directory.Build.props ($TargetFramework)" -ForegroundColor DarkGray

    try {
        Stop-ConflictingDesignerProcesses -RepoRootPath $RepoRoot -BuildOutputPath $OutputDir

        Write-Host ""
        Write-Host "Running: dotnet restore ..." -ForegroundColor Yellow
        & dotnet restore "$SubmoduleCsproj" --nologo -p:UseSharedCompilation=false "-p:TargetFramework=$TargetFramework"
        if ($LASTEXITCODE -ne 0) { Write-Error "Restore failed with exit code $LASTEXITCODE."; exit $LASTEXITCODE }

        Write-Host "Running: dotnet build ..." -ForegroundColor Yellow
        & dotnet build "$SubmoduleCsproj" `
            --configuration $Configuration `
            --nologo `
            --no-restore `
            -maxcpucount:1 `
            -p:UseSharedCompilation=false `
            "-p:TargetFramework=$TargetFramework"
        if ($LASTEXITCODE -ne 0) { Write-Error "Build failed with exit code $LASTEXITCODE."; exit $LASTEXITCODE }
    }
    finally {
        # Always clean up the temporary file
        Remove-Item $TempProps -ErrorAction SilentlyContinue
        Write-Host "  Removed temporary Directory.Build.props" -ForegroundColor DarkGray
    }

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
# Required: build a .NET Framework 4.8.1 variant for net4x project support.
# This allows the designer to load .NET Framework user assemblies.
# This is mandatory for packaging and must succeed.
# ---------------------------------------------------------------------------
$LegacyTfm       = "net481"
$LegacyOutputDir = Join-Path $RepoRoot "tools\XamlDesignerLegacy"
$LegacyBuiltDir  = Join-Path $RepoRoot "external\WpfDesigner\XamlDesigner\bin\$Configuration\$LegacyTfm"

Write-Host ""
Write-Host "=== Building .NET Framework Designer ($LegacyTfm) ===" -ForegroundColor Cyan

if (-not (Test-Path $LegacyOutputDir)) {
    New-Item -ItemType Directory -Path $LegacyOutputDir | Out-Null
}

$legacyProps = @"
<!-- Auto-generated by build-designer.ps1 — do not commit -->
<Project>
    <PropertyGroup>
        <TargetFramework>$LegacyTfm</TargetFramework>
        <EnableWindowsTargeting>true</EnableWindowsTargeting>
    </PropertyGroup>
</Project>
"@
Set-Content -Path $TempProps -Value $legacyProps -Encoding UTF8
Write-Host "  Wrote temporary Directory.Build.props ($LegacyTfm)" -ForegroundColor DarkGray

$legacyOk = $false
try {
    & dotnet restore "$SubmoduleCsproj" --nologo -p:UseSharedCompilation=false "-p:TargetFramework=$LegacyTfm" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Restore failed" }

    & dotnet build "$SubmoduleCsproj" `
        --configuration $Configuration `
        --nologo `
        --no-restore `
        -maxcpucount:1 `
        -p:UseSharedCompilation=false `
        "-p:TargetFramework=$LegacyTfm" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }

    if (-not (Test-Path $LegacyBuiltDir)) { throw "Output directory not found" }

    Get-ChildItem -Path $LegacyOutputDir -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $LegacyBuiltDir '*') -Destination $LegacyOutputDir -Recurse -Force
    $legacyOk = $true
}
catch {
    Write-Error "net481 designer build failed: $_"
}
finally {
    Remove-Item $TempProps -ErrorAction SilentlyContinue
    Write-Host "  Removed temporary Directory.Build.props" -ForegroundColor DarkGray
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
