[CmdletBinding()]
param(
    [string]$ConfigPath = '',
    [switch]$ValidateOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

if (-not $ConfigPath) {
    $ConfigPath = Join-Path $PSScriptRoot 'server-address.json'
}

function Get-ValidatedServerUrl {
    param([Parameter(Mandatory = $true)][string]$Value)

    # Match the original text as well as the parsed URI. This rejects aliases,
    # escaped paths, credentials and alternate IPv4 representations.
    $pattern = '\Ahttp://(?<address>(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}):8765/?\z'
    $match = [regex]::Match($Value, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
        throw 'Use an address such as http://192.168.1.10:8765/ with no extra path, credentials, query or fragment.'
    }

    $octets = @($match.Groups['address'].Value.Split('.') | ForEach-Object { [int]$_ })
    if (@($octets | Where-Object { $_ -gt 255 }).Count -ne 0) {
        throw 'The server address is not a valid IPv4 address.'
    }

    $isPrivate = ($octets[0] -eq 10) -or
        (($octets[0] -eq 172) -and ($octets[1] -ge 16) -and ($octets[1] -le 31)) -or
        (($octets[0] -eq 192) -and ($octets[1] -eq 168))
    if (-not $isPrivate) {
        throw 'The server address must be a private IPv4 address on the local network.'
    }

    $uri = [uri]$Value
    if (($uri.Scheme -ne 'http') -or ($uri.Port -ne 8765) -or
        ($uri.AbsolutePath -ne '/') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'The server URL must use HTTP, port 8765 and the root path only.'
    }
    return $uri.AbsoluteUri
}

function Find-AppBrowser {
    $locations = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)
    foreach ($relativePath in @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')) {
        foreach ($location in $locations) {
            if ($location) {
                $candidate = Join-Path $location $relativePath
                if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                    return $candidate
                }
            }
        }
    }
    return $null
}

function Test-ServerReachable {
    param([Parameter(Mandatory = $true)][uri]$ServerUri)

    $client = New-Object System.Net.Sockets.TcpClient
    $waitHandle = $null
    try {
        $connection = $client.BeginConnect($ServerUri.Host, $ServerUri.Port, $null, $null)
        $waitHandle = $connection.AsyncWaitHandle
        if (-not $waitHandle.WaitOne(2500)) {
            return $false
        }
        $client.EndConnect($connection)
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        if ($waitHandle) { $waitHandle.Close() }
        $client.Close()
    }
}

function Copy-ClientFile {
    param([string]$Source, [string]$Destination)
    if ([IO.Path]::GetFullPath($Source) -ne [IO.Path]::GetFullPath($Destination)) {
        Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
    }
    if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash) {
        throw ('Copied file verification failed: ' + [IO.Path]::GetFileName($Source))
    }
}

function New-LocalArchiveShortcut {
    param([string]$ShortcutPath, [string]$LauncherPath, [string]$IconPath)
    $shell = $null
    $shortcut = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcut = $shell.CreateShortcut($ShortcutPath)
        $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $LauncherPath + '"'
        $shortcut.WorkingDirectory = Split-Path -Parent $LauncherPath
        $shortcut.Description = 'Arsheefna shared archive on the local network.'
        if (Test-Path -LiteralPath $IconPath -PathType Leaf) { $shortcut.IconLocation = $IconPath + ',0' }
        $shortcut.Save()
    }
    finally {
        if ($shortcut) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
        if ($shell) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
    }
}

function Copy-ArchiveDesktopShortcut {
    param([string]$Source, [string]$Destination)
    Copy-Item -LiteralPath $Source -Destination $Destination -Force -ErrorAction Stop
}

function Write-ArchiveUrlShortcut {
    param([string]$ShortcutPath, [string]$ServerUrl, [string]$IconPath)
    $shortcutText = "[InternetShortcut]`r`nURL=$ServerUrl`r`n"
    if (Test-Path -LiteralPath $IconPath -PathType Leaf) { $shortcutText += "IconFile=$IconPath`r`nIconIndex=0`r`n" }
    [IO.File]::WriteAllText($ShortcutPath, $shortcutText, [Text.Encoding]::Unicode)
}

function Remove-TemporaryArchiveShortcut {
    param([string]$ClientDirectory, [string]$ShortcutPath)
    $clientRoot = [IO.Path]::GetFullPath($ClientDirectory).TrimEnd([char]'\')
    $target = [IO.Path]::GetFullPath($ShortcutPath)
    $name = [IO.Path]::GetFileName($target)
    if (-not $target.StartsWith($clientRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $name -notmatch '^\.shortcut-[0-9a-f]{32}\.lnk$' -or
        (Split-Path -Parent $target) -ne $clientRoot) { throw 'Unsafe temporary shortcut cleanup path.' }
    if (Test-Path -LiteralPath $target -PathType Leaf) { Remove-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue }
}

function Install-ArchiveDesktopShortcut {
    param([string]$Desktop, [string]$ClientDirectory, [string]$ServerUrl, [string]$IconPath)
    if (-not $Desktop) {
        return [pscustomobject]@{ Created=$false; Type='none'; Path=''; Error='Windows did not provide a Desktop path.' }
    }
    $temporary = Join-Path $ClientDirectory ('.shortcut-' + [guid]::NewGuid().ToString('N') + '.lnk')
    $primaryError = ''
    try {
        New-Item -ItemType Directory -Path $Desktop -Force -ErrorAction Stop | Out-Null
        New-LocalArchiveShortcut -ShortcutPath $temporary -LauncherPath (Join-Path $ClientDirectory 'Start-Arsheefna.ps1') -IconPath $IconPath
        $shortcutPath = Join-Path $Desktop 'Arsheefna - Network.lnk'
        Copy-ArchiveDesktopShortcut -Source $temporary -Destination $shortcutPath
        return [pscustomobject]@{ Created=$true; Type='lnk'; Path=$shortcutPath; Error='' }
    }
    catch { $primaryError = $_.Exception.Message }
    finally {
        try { Remove-TemporaryArchiveShortcut -ClientDirectory $ClientDirectory -ShortcutPath $temporary } catch { }
    }
    try {
        New-Item -ItemType Directory -Path $Desktop -Force -ErrorAction Stop | Out-Null
        $shortcutPath = Join-Path $Desktop 'Arsheefna - Network.url'
        Write-ArchiveUrlShortcut -ShortcutPath $shortcutPath -ServerUrl $ServerUrl -IconPath $IconPath
        return [pscustomobject]@{ Created=$true; Type='url'; Path=$shortcutPath; Error=$primaryError }
    }
    catch {
        return [pscustomobject]@{ Created=$false; Type='none'; Path=''; Error=($primaryError + ' / ' + $_.Exception.Message) }
    }
}

try {
    if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
        throw "Missing server-address.json. Keep it beside this installer. Looked for: $ConfigPath"
    }
    $settings = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (($null -eq $settings) -or ($null -eq $settings.PSObject.Properties['url']) -or ($settings.url -isnot [string])) {
        throw 'server-address.json must contain a string named url.'
    }
    $serverUrl = Get-ValidatedServerUrl -Value $settings.url
    if ($ValidateOnly) { Write-Output $serverUrl; exit 0 }

    foreach ($file in @('Start-Arsheefna.ps1', 'Start-Arsheefna.bat')) {
        if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $file) -PathType Leaf)) {
            throw ('Missing launcher file. Extract the complete ZIP first: ' + $file)
        }
    }
    if (-not $env:LOCALAPPDATA) { throw 'The current user has no LOCALAPPDATA directory.' }
    $clientDirectory = Join-Path $env:LOCALAPPDATA 'Arsheefna-NetworkClient'
    New-Item -ItemType Directory -Path $clientDirectory -Force | Out-Null
    foreach ($file in @('Start-Arsheefna.ps1', 'Start-Arsheefna.bat', 'app.ico')) {
        $source = Join-Path $PSScriptRoot $file
        if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-ClientFile -Source $source -Destination (Join-Path $clientDirectory $file) }
    }
    [IO.File]::WriteAllText((Join-Path $clientDirectory 'server-address.json'), (@{ url=$serverUrl } | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
    Write-ArchiveUrlShortcut -ShortcutPath (Join-Path $clientDirectory 'Arsheefna-Network.url') -ServerUrl $serverUrl -IconPath (Join-Path $clientDirectory 'app.ico')
    $desktop = ''
    try { $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory) } catch { }
    $result = Install-ArchiveDesktopShortcut -Desktop $desktop -ClientDirectory $clientDirectory -ServerUrl $serverUrl -IconPath (Join-Path $clientDirectory 'app.ico')
    if ($result.Created) {
        Write-Host 'The Arsheefna - Network shortcut was created on your Desktop.' -ForegroundColor Green
    }
    else {
        Write-Warning 'Windows could not write a Desktop shortcut. The network launcher is installed and can still be used.'
        Write-Host 'Run Start-Arsheefna.bat from this extracted folder to open the archive.'
        Write-Host ('Installed launcher: ' + (Join-Path $clientDirectory 'Start-Arsheefna.bat'))
    }
    Write-Host ('Server: ' + $serverUrl)
    if (-not (Test-ServerReachable -ServerUri ([uri]$serverUrl))) {
        Write-Warning 'The server did not respond. Keep the first PC and its archive program running, and connect all PCs to the same router.'
    }
    exit 0
}
catch {
    Write-Host ('Installation failed: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'You can also run Start-Arsheefna.bat directly from the complete extracted folder.'
    exit 1
}

