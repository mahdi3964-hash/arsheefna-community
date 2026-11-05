[CmdletBinding()]
param([string]$ConfigPath = '', [switch]$ValidateOnly)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
if (-not $ConfigPath) { $ConfigPath = Join-Path $PSScriptRoot 'server-address.json' }

function Get-ValidatedServerUrl {
    param([Parameter(Mandatory=$true)][string]$Value)
    $pattern = '\Ahttp://(?<address>(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}):8765/?\z'
    $match = [regex]::Match($Value,$pattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) { throw 'Use a private IPv4 address with http and port 8765, without an extra path.' }
    $octets = @($match.Groups['address'].Value.Split('.') | ForEach-Object { [int]$_ })
    if (@($octets | Where-Object { $_ -gt 255 }).Count) { throw 'Invalid IPv4 address.' }
    $private = ($octets[0] -eq 10) -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168)
    if (-not $private) { throw 'The archive address must be on the private local network.' }
    return ([uri]$Value).AbsoluteUri
}

function Find-AppBrowser {
    foreach ($relative in @('Microsoft\Edge\Application\msedge.exe','Google\Chrome\Application\chrome.exe')) {
        foreach ($root in @(${env:ProgramFiles(x86)},$env:ProgramFiles,$env:LOCALAPPDATA)) {
            if ($root) {
                $candidate = Join-Path $root $relative
                if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
            }
        }
    }
    return $null
}

function Start-ArchiveWindow {
    param([Parameter(Mandatory=$true)][string]$ServerUrl)
    $validatedUrl = Get-ValidatedServerUrl $ServerUrl
    $browser = Find-AppBrowser
    if ($browser) {
        try {
            # Open the interactive archive window for the user.
            Start-Process -FilePath $browser -ArgumentList ('--app="' + $validatedUrl + '"') -ErrorAction Stop | Out-Null
            return
        } catch { Write-Warning 'The app browser could not start. Trying the default browser.' }
    }
    Start-Process -FilePath $validatedUrl -ErrorAction Stop | Out-Null
}

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) { throw 'Keep server-address.json beside Start-Arsheefna.ps1. Extract the complete ZIP first.' }
    $settings = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $settings -or $null -eq $settings.PSObject.Properties['url'] -or $settings.url -isnot [string]) { throw 'server-address.json must contain a string named url.' }
    $serverUrl = Get-ValidatedServerUrl $settings.url
    if ($ValidateOnly) { Write-Output $serverUrl; exit 0 }
    Start-ArchiveWindow $serverUrl
    exit 0
} catch {
    Write-Host ('Could not open Arsheefna: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'You can also open Arsheefna-Network.url or the address in server-address.json directly in your browser.'
    exit 1
}
