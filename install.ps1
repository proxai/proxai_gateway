# ProxAI Gateway installer for Windows.
#
# Usage:
#   irm https://github.com/proxai/proxai_gateway/raw/main/install.ps1 | iex
#
# Environment variables:
#   PROXAI_GATEWAY_VERSION  Pin to a specific release tag (e.g. "v2026.5.7").
#                           Defaults to "latest".

$ErrorActionPreference = 'Stop'

$Repo = 'proxai/proxai_gateway'
$BinaryName = 'proxai-gateway.exe'
$InstallDir = Join-Path $env:USERPROFILE '.proxai\bin'
$Version = if ($env:PROXAI_GATEWAY_VERSION) { $env:PROXAI_GATEWAY_VERSION } else { 'latest' }

function Get-ProxaiArch {
    $procArch = $env:PROCESSOR_ARCHITECTURE
    if ($procArch -eq 'ARM64') {
        return 'arm64'
    }
    if ([Environment]::Is64BitOperatingSystem) {
        return 'x64'
    }
    throw "unsupported architecture: $procArch (32-bit Windows is not supported)"
}

function Get-DownloadUrl {
    param(
        [string]$Arch,
        [string]$Version
    )
    if ($Version -eq 'latest') {
        $segment = 'latest/download'
    } else {
        $segment = "download/$Version"
    }
    return "https://github.com/$Repo/releases/$segment/proxai-gateway-win32-$Arch.exe"
}

function Add-ToUserPath {
    param([string]$DirToAdd)

    $current = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if (-not $current) { $current = '' }

    $entries = $current -split ';' | Where-Object { $_ -ne '' }
    foreach ($entry in $entries) {
        if ([string]::Equals($entry.TrimEnd('\'), $DirToAdd.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            return $false
        }
    }

    $newPath = if ($current -eq '') { $DirToAdd } else { "$current;$DirToAdd" }
    [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    return $true
}

try {
    $arch = Get-ProxaiArch
    $url = Get-DownloadUrl -Arch $arch -Version $Version

    Write-Host "installing ProxAI Gateway (win32-$arch, $Version)"
    Write-Host "source: $url"

    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    }

    $dest = Join-Path $InstallDir $BinaryName
    $tmp = Join-Path $InstallDir ".$BinaryName.download"

    if (Test-Path $tmp) { Remove-Item $tmp -Force }

    try {
        $oldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    } catch {
        if (Test-Path $tmp) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
        throw "download failed: $url (release may not exist yet for $Version)"
    } finally {
        $ProgressPreference = $oldProgress
    }

    if (Test-Path $dest) { Remove-Item $dest -Force }
    Move-Item -Path $tmp -Destination $dest

    Write-Host "installed $dest"

    $changed = Add-ToUserPath -DirToAdd $InstallDir
    if ($changed) {
        Write-Host "updated user PATH to include $InstallDir"
    }

    Write-Host ''
    Write-Host 'ProxAI Gateway installed.'

    $cfg = Join-Path $HOME '.proxai\proxai-gateway\config.toml'
    if (Test-Path $cfg) {
        Write-Host 'Existing configuration detected; reconciling daemon state...'
        try {
            & $dest setup
        } catch {
            Write-Host "Run 'proxai-gateway status' for details."
        }
    } else {
        Write-Host 'Open a new PowerShell window, then run: proxai-gateway setup'
    }
    exit 0
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
