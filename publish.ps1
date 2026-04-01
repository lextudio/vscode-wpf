Param(
	[string]$Token
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$here = Split-Path -Path $MyInvocation.MyCommand.Definition -Parent
Set-Location $here

$tokenStoreDir = Join-Path $env:LOCALAPPDATA 'vscode-wpf'
$tokenStorePath = Join-Path $tokenStoreDir 'vsce-pat.bin'

function Save-Token {
	param(
		[string]$PlainTextToken
	)

	if ([string]::IsNullOrWhiteSpace($PlainTextToken)) {
		throw 'Cannot save an empty Marketplace token.'
	}

	if (-not (Test-Path $tokenStoreDir)) {
		New-Item -ItemType Directory -Path $tokenStoreDir -Force | Out-Null
	}

	$secureToken = ConvertTo-SecureString $PlainTextToken -AsPlainText -Force
	$encrypted = ConvertFrom-SecureString $secureToken
	Set-Content -Path $tokenStorePath -Value $encrypted -Encoding UTF8
}

function Load-Token {
	if (-not (Test-Path $tokenStorePath)) {
		return $null
	}

	try {
		$encrypted = (Get-Content -Path $tokenStorePath -Raw -Encoding UTF8).Trim()
		if ([string]::IsNullOrWhiteSpace($encrypted)) {
			return $null
		}

		$secureToken = ConvertTo-SecureString $encrypted
		$credential = New-Object System.Management.Automation.PSCredential ('vsce', $secureToken)
		return $credential.GetNetworkCredential().Password
	}
	catch {
		Write-Warning "Stored Marketplace token could not be read from $tokenStorePath."
		return $null
	}
}

function Read-TokenFromPrompt {
	if (-not [Environment]::UserInteractive) {
		return $null
	}

	Write-Host 'Enter VS Code Marketplace token (PAT):'
	$secureInput = Read-Host -AsSecureString
	if (-not $secureInput) {
		return $null
	}

	$credential = New-Object System.Management.Automation.PSCredential ('vsce', $secureInput)
	$plain = $credential.GetNetworkCredential().Password
	if ([string]::IsNullOrWhiteSpace($plain)) {
		return $null
	}

	return $plain
}

function Get-VsixFiles {
	$pkg = Get-Content package.json -Raw | ConvertFrom-Json
	$expected = @(
		"{0}-{1}-win32-x64.vsix" -f $pkg.name, $pkg.version
		"{0}-{1}-win32-arm64.vsix" -f $pkg.name, $pkg.version
	)

	$matches = @()
	foreach ($name in $expected) {
		$path = Join-Path $here $name
		if (Test-Path $path) {
			$matches += (Get-Item $path)
		}
	}

	if ($matches.Count -gt 0) {
		return $matches
	}

	return Get-ChildItem -Path $here -Filter *.vsix | Sort-Object Name
}

if (-not [string]::IsNullOrWhiteSpace($Token)) {
	Save-Token $Token
	Write-Host "Saved Marketplace token for the current Windows user at $tokenStorePath"
}
else {
	$Token = Load-Token
}

if ([string]::IsNullOrWhiteSpace($Token)) {
	$Token = Read-TokenFromPrompt

	if (-not [string]::IsNullOrWhiteSpace($Token)) {
		Save-Token $Token
		Write-Host "Saved Marketplace token for the current Windows user at $tokenStorePath"
	}
}

if ([string]::IsNullOrWhiteSpace($Token)) {
	Write-Warning 'No Marketplace token was provided, and no stored token could be loaded or entered. Publishing was skipped.'
	exit 1
}

$vsixFiles = @(Get-VsixFiles)
if ($vsixFiles.Count -eq 0) {
	Write-Warning 'No .vsix files were found to publish. Run dist.windows.ps1 first.'
	exit 1
}

$env:VSCE_PAT = $Token
$publishFailures = @()

foreach ($vsix in $vsixFiles) {
	Write-Host "Publishing $($vsix.Name) to VS Code Marketplace..."
	& npx -y vsce publish --packagePath $vsix.FullName
	if ($LASTEXITCODE -ne 0) {
		$publishFailures += $vsix.Name
		Write-Warning "Publishing failed for $($vsix.Name). The stored token may be invalid or lack permission."
	}
}

if ($publishFailures.Count -gt 0) {
	Write-Warning ("Marketplace publish did not fully succeed. Failed packages: " + ($publishFailures -join ', '))
	exit 1
}

Write-Host 'Marketplace publish completed successfully.'
