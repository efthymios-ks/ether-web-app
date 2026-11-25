#Requires -Version 5.1

<#
.SYNOPSIS
    Rebuilds Ether on every save, serves it, and opens one or two browser windows to pair;
    with -Tunnel, also puts it on a public HTTPS address for phones.

.DESCRIPTION
    Makes sure Node.js and the npm packages are there through Invoke-Test.ps1
    -InstallOnly, starts the build watcher, waits for the first build, starts the
    local server, then opens the browser with its own profile.

    http://localhost is a secure context, so the camera, the service worker and
    crypto.subtle work there. -Peers 2 opens two windows with separate profiles,
    so each has its own device ID and history, and the two can pair with each
    other through copy and paste.

    Phones need HTTPS. Two ways:

    -Tunnel hosts the local server through a Microsoft dev tunnel, which gives a
    real HTTPS address with a valid certificate (https://<id>-<port>.<region>.devtunnels.ms).
    The page loads through the tunnel; the transfer itself still goes straight
    across the Wi-Fi between the devices. devtunnel is used from PATH when it is
    there; otherwise a pinned build is downloaded into
    %LOCALAPPDATA%\ether-web-app\tools, its SHA256 checked, and it is recorded in
    installed.json there. The first run asks you to sign in (GitHub by default)
    in the browser. The tunnel is persistent: its ID is kept in .devtunnel, so the
    address stays the same between runs, and so do the phone's device ID, history
    and Home Screen install. Anyone with the address can open the page. Scan the
    QR printed in the terminal with the phone; the first visit shows a dev tunnels
    notice, tap Continue.

    -Lan serves on every interface with a self-signed certificate it creates in
    .certificates (Windows only). The phone warns about the certificate once;
    accept it to continue. The service worker doesn't install on a page with a
    certificate error.

    With -Tunnel or -Lan the browser on this computer opens the same public or LAN
    address the phone uses, so the links inside pairing QR codes work on the phone.

    Source maps are on, so breakpoints work in the TypeScript files.

    Exit codes:
      0  the watcher stopped, or the tools are ready with -InstallOnly
      1  the first build failed
      3  Node.js, the npm packages, devtunnel, the certificate or the browser are unavailable
      4  the dev tunnel could not sign in or start

.PARAMETER Browser
    Chrome, Edge or Chromium. Default Chrome.

.PARAMETER BrowserPath
    Explicit browser executable, for example Chrome for Testing. Wins over -Browser.

.PARAMETER ProfilePath
    Browser profile folder. Default .debug-profile beside this script; with -Peers 2
    the windows use its subfolders a and b.

.PARAMETER Peers
    1 or 2 browser windows. Default 1.

.PARAMETER Port
    Server port. Default 5173.

.PARAMETER Tunnel
    Host the server through a dev tunnel, for phones on any network that reaches the internet.

.PARAMETER TunnelAccount
    The account devtunnel signs in with the first time: GitHub or Microsoft. Default GitHub.

.PARAMETER NewTunnel
    Forget the saved tunnel and create a new one (a new address).

.PARAMETER Lan
    Serve over HTTPS on every network interface, with a self-signed certificate.

.PARAMETER NoBrowser
    Build and serve only.

.PARAMETER NoWatch
    Build once, serve, and stop when Ctrl+C is pressed.

.PARAMETER InstallOnly
    Make sure Node.js, the npm packages and, with -Tunnel, devtunnel are there, then stop.

.PARAMETER NoInstall
    Never download devtunnel; fail with its download address instead.

.PARAMETER RemoveTools
    Remove the devtunnel this script downloaded, then stop. A devtunnel you installed yourself is never touched.

.EXAMPLE
    ./Start-Debug.ps1

.EXAMPLE
    ./Start-Debug.ps1 -Peers 2

.EXAMPLE
    ./Start-Debug.ps1 -Tunnel

.EXAMPLE
    ./Start-Debug.ps1 -Tunnel -TunnelAccount Microsoft

.EXAMPLE
    ./Start-Debug.ps1 -Lan -NoBrowser

.EXAMPLE
    ./Start-Debug.ps1 -RemoveTools
#>

[CmdletBinding()]
param(
    [ValidateSet('Chrome', 'Edge', 'Chromium')]
    [string]$Browser = 'Chrome',

    [ValidateNotNullOrEmpty()]
    [string]$BrowserPath,

    [ValidateNotNullOrEmpty()]
    [string]$ProfilePath,

    [ValidateRange(1, 2)]
    [int]$Peers = 1,

    [ValidateRange(1024, 65535)]
    [int]$Port = 5173,

    [switch]$Tunnel,

    [ValidateSet('GitHub', 'Microsoft')]
    [string]$TunnelAccount = 'GitHub',

    [switch]$NewTunnel,

    [switch]$Lan,

    [switch]$NoBrowser,

    [switch]$NoWatch,

    [switch]$InstallOnly,

    [switch]$NoInstall,

    [switch]$RemoveTools
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# powershell.exe -File leaves $PSScriptRoot empty in the param defaults of an advanced script.
if (-not $ProfilePath) { $ProfilePath = Join-Path -Path $PSScriptRoot -ChildPath '.debug-profile' }

$script:DistPath = Join-Path $PSScriptRoot 'dist'
$script:BuildScript = Join-Path $PSScriptRoot 'scripts/build.mjs'
$script:ServeScript = Join-Path $PSScriptRoot 'scripts/serve.mjs'
$script:QrScript = Join-Path $PSScriptRoot 'scripts/print-qr.mjs'
$script:CertificateFolder = Join-Path $PSScriptRoot '.certificates'
$script:CertificatePath = Join-Path $script:CertificateFolder 'ether-debug.pfx'
$script:CertificatePassword = 'ether-debug'
$script:TunnelFolder = Join-Path $PSScriptRoot '.devtunnel'
$script:TunnelStatePath = Join-Path $script:TunnelFolder 'tunnel.json'
$script:TunnelLogPath = Join-Path $script:TunnelFolder 'host.log'
$script:FirstBuildTimeoutInSeconds = 60
$script:TunnelStartTimeoutInSeconds = 60
$script:SignedInPattern = 'Logged in as'
$script:SignInNeededPattern = 'token expired|not logged in|login required|unauthorized|\b401\b'
$script:TunnelMissingPattern = 'not found|does not exist|\b404\b'
$script:PollIntervalInMilliseconds = 250

# Pinned devtunnel build, from its winget manifest (Microsoft.devtunnel).
$script:DevTunnelVersion = '1.0.2115+e16833f284'
$script:DevTunnelUrl = 'https://tunnelsassetsprod.blob.core.windows.net/cli/1.0.2115+e16833f284/devtunnel.exe'
$script:DevTunnelSha256 = 'f11c797e90397a0a8e9bee711d500473632be27839deeb4fb3d0f5dbc6ffd2dc'
$script:ToolsRoot = Join-Path $env:LOCALAPPDATA 'ether-web-app\tools'
$script:ToolsManifestPath = Join-Path $script:ToolsRoot 'installed.json'
$script:DevTunnelFolder = Join-Path $script:ToolsRoot ('devtunnel-' + ($script:DevTunnelVersion -replace '\+.*$', ''))
$script:DevTunnelPath = Join-Path $script:DevTunnelFolder 'devtunnel.exe'

$script:WindowsBrowserPaths = @{
    Chrome = 'Google\Chrome\Application\chrome.exe'
    Edge = 'Microsoft\Edge\Application\msedge.exe'
    Chromium = 'Chromium\Application\chrome.exe'
}

$script:OtherBrowserPaths = @{
    Chrome = @('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'google-chrome', 'google-chrome-stable')
    Edge = @('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'microsoft-edge', 'microsoft-edge-stable')
    Chromium = @('/Applications/Chromium.app/Contents/MacOS/Chromium', 'chromium', 'chromium-browser')
}

function Exit-WithError {
    param(
        [Parameter(Mandatory)][string]$Message,
        [Parameter(Mandatory)][int]$ExitCode
    )

    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit $ExitCode
}

function Read-ToolsManifest {
    if (-not (Test-Path -LiteralPath $script:ToolsManifestPath)) { return @{} }

    $manifest = @{}
    $json = Get-Content -LiteralPath $script:ToolsManifestPath -Raw | ConvertFrom-Json
    foreach ($property in $json.PSObject.Properties) { $manifest[$property.Name] = $property.Value }

    return $manifest
}

function Write-ToolsManifest {
    param([Parameter(Mandatory)][hashtable]$Manifest)

    if ($Manifest.Count -eq 0) {
        Remove-Item -LiteralPath $script:ToolsManifestPath -Force -ErrorAction SilentlyContinue
        return
    }

    $null = New-Item -ItemType Directory -Path $script:ToolsRoot -Force
    $Manifest | ConvertTo-Json | Set-Content -LiteralPath $script:ToolsManifestPath -Encoding UTF8
}

# Removes only what the manifest says this script downloaded.
function Remove-DevTunnelTool {
    $manifest = Read-ToolsManifest
    if (-not $manifest.ContainsKey('devtunnel')) {
        Write-Host 'No devtunnel installed by this script.' -ForegroundColor DarkGray
        return
    }

    $folder = $manifest['devtunnel'].folder
    if ($folder -and (Test-Path -LiteralPath $folder)) { Remove-Item -LiteralPath $folder -Recurse -Force }
    $manifest.Remove('devtunnel')
    Write-ToolsManifest -Manifest $manifest
    Write-Host "Removed devtunnel from $folder" -ForegroundColor Green
}

function Install-DevTunnel {
    if ($NoInstall) {
        Exit-WithError "devtunnel is not installed (-NoInstall). Download it from $script:DevTunnelUrl and put it on PATH." 3
    }

    Write-Host "Downloading devtunnel $script:DevTunnelVersion..." -ForegroundColor DarkGray
    # Windows PowerShell 5.1 may default to TLS 1.0, which the download host refuses.
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $null = New-Item -ItemType Directory -Path $script:DevTunnelFolder -Force
    $download = Join-Path $script:DevTunnelFolder 'devtunnel.exe.download'
    $previousProgress = $ProgressPreference
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $script:DevTunnelUrl -OutFile $download -UseBasicParsing
    }
    catch {
        Remove-Item -LiteralPath $download -Force -ErrorAction SilentlyContinue
        Exit-WithError "devtunnel download failed: $($_.Exception.Message)" 3
    }
    finally {
        $ProgressPreference = $previousProgress
    }

    $hash = (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hash -ne $script:DevTunnelSha256) {
        Remove-Item -LiteralPath $download -Force
        Exit-WithError "devtunnel download has SHA256 $hash, expected $script:DevTunnelSha256; not installed." 3
    }

    Move-Item -LiteralPath $download -Destination $script:DevTunnelPath -Force
    $manifest = Read-ToolsManifest
    $manifest['devtunnel'] = [ordered]@{
        version = $script:DevTunnelVersion
        folder = $script:DevTunnelFolder
        installedAt = (Get-Date).ToString('o')
    }
    Write-ToolsManifest -Manifest $manifest
    Write-Host "Installed devtunnel to $script:DevTunnelPath" -ForegroundColor Green
}

# devtunnel from PATH, else the pinned copy in the tools folder, downloading it the first time.
function Get-DevTunnelPath {
    $onPath = Get-Command -Name devtunnel -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($onPath) { return $onPath.Source }

    if (-not (Test-Path -LiteralPath $script:DevTunnelPath)) { Install-DevTunnel }

    return $script:DevTunnelPath
}

# Runs devtunnel and returns its output lines and exit code, without stopping on a non-zero exit.
function Invoke-DevTunnel {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $Executable @Arguments 2>&1 | ForEach-Object { "$_" })
    }
    finally {
        $ErrorActionPreference = $previousPreference
    }

    return [pscustomobject]@{ Output = $output; ExitCode = $LASTEXITCODE }
}

function Invoke-DevTunnelLogin {
    param([Parameter(Mandatory)][string]$Executable)

    Write-Host "Signing in to dev tunnels with $TunnelAccount; finish in the browser that opens." -ForegroundColor Cyan
    $loginArguments = if ($TunnelAccount -eq 'GitHub') { @('user', 'login', '--github') } else { @('user', 'login') }
    & $Executable @loginArguments | Out-Host
    if ($LASTEXITCODE -ne 0) { Exit-WithError 'devtunnel sign-in failed.' 4 }
}

# Signed in only when devtunnel says so; "Login token expired" and "Not logged in" both mean sign in again.
function Confirm-DevTunnelLogin {
    param([Parameter(Mandatory)][string]$Executable)

    $status = Invoke-DevTunnel -Executable $Executable -Arguments @('user', 'show')
    $text = $status.Output -join ' '
    if ($status.ExitCode -eq 0 -and $text -match $script:SignedInPattern -and $text -notmatch $script:SignInNeededPattern) {
        Write-Host $text -ForegroundColor DarkGray
        return
    }

    Invoke-DevTunnelLogin -Executable $Executable
}

# Runs devtunnel, and when it fails because the sign-in expired, signs in once and runs it again.
function Invoke-DevTunnelSignedIn {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    $result = Invoke-DevTunnel -Executable $Executable -Arguments $Arguments
    if ($result.ExitCode -eq 0 -or ($result.Output -join ' ') -notmatch $script:SignInNeededPattern) { return $result }

    Invoke-DevTunnelLogin -Executable $Executable
    return Invoke-DevTunnel -Executable $Executable -Arguments $Arguments
}

# The tunnel ID in devtunnel's JSON or text output, or $null.
function Find-TunnelId {
    param([string[]]$Output)

    $text = $Output -join "`n"
    $json = [regex]::Match($text, '"tunnelId"\s*:\s*"([^"]+)"')
    if ($json.Success) { return $json.Groups[1].Value }

    $plain = [regex]::Match($text, 'Tunnel ID\s*:\s*(\S+)')
    if ($plain.Success) { return $plain.Groups[1].Value }

    return $null
}

function Add-TunnelPort {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$TunnelId
    )

    $result = Invoke-DevTunnelSignedIn -Executable $Executable -Arguments @('port', 'create', $TunnelId, '--port-number', "$Port", '--protocol', 'http')
    if ($result.ExitCode -ne 0) { Exit-WithError "devtunnel port create failed: $($result.Output -join ' ')" 4 }
}

# The saved tunnel when it still exists, else a new anonymous-access tunnel with the port added.
function Get-TunnelId {
    param([Parameter(Mandatory)][string]$Executable)

    $null = New-Item -ItemType Directory -Path $script:TunnelFolder -Force
    if ($NewTunnel) { Remove-Item -LiteralPath $script:TunnelStatePath -Force -ErrorAction SilentlyContinue }

    if (Test-Path -LiteralPath $script:TunnelStatePath) {
        $saved = Get-Content -LiteralPath $script:TunnelStatePath -Raw | ConvertFrom-Json
        $existing = Invoke-DevTunnelSignedIn -Executable $Executable -Arguments @('show', $saved.tunnelId, '--json')
        $text = $existing.Output -join "`n"
        if ($existing.ExitCode -eq 0 -and (Find-TunnelId -Output $existing.Output)) {
            if ($text -notmatch "`"portNumber`"\s*:\s*$Port\b") { Add-TunnelPort -Executable $Executable -TunnelId $saved.tunnelId }
            return $saved.tunnelId
        }

        # Only a tunnel the service no longer knows is replaced; any other failure is reported as it is.
        if ($text -notmatch $script:TunnelMissingPattern) {
            Exit-WithError "devtunnel show $($saved.tunnelId) failed: $($existing.Output -join ' ')" 4
        }

        Write-Host "Saved tunnel $($saved.tunnelId) no longer exists (tunnels expire after 30 days unused); creating a new one." -ForegroundColor Yellow
    }

    $created = Invoke-DevTunnelSignedIn -Executable $Executable -Arguments @('create', '--allow-anonymous', '--json')
    $tunnelId = Find-TunnelId -Output $created.Output
    if ($created.ExitCode -ne 0 -or -not $tunnelId) {
        Exit-WithError "devtunnel create failed: $($created.Output -join ' ')" 4
    }

    Add-TunnelPort -Executable $Executable -TunnelId $tunnelId
    [ordered]@{ tunnelId = $tunnelId; port = $Port } | ConvertTo-Json | Set-Content -LiteralPath $script:TunnelStatePath -Encoding UTF8
    Write-Host "Created tunnel $tunnelId" -ForegroundColor Green

    return $tunnelId
}

# Starts hosting and waits for the browser address in its output.
function Start-TunnelHost {
    param(
        [Parameter(Mandatory)][string]$Executable,
        [Parameter(Mandatory)][string]$TunnelId
    )

    Remove-Item -LiteralPath $script:TunnelLogPath, "$script:TunnelLogPath.err" -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $Executable -ArgumentList @('host', $TunnelId) -NoNewWindow -PassThru `
        -RedirectStandardOutput $script:TunnelLogPath -RedirectStandardError "$script:TunnelLogPath.err"

    $deadline = (Get-Date).AddSeconds($script:TunnelStartTimeoutInSeconds)
    while ((Get-Date) -lt $deadline) {
        if ($process.HasExited) { break }
        if (Test-Path -LiteralPath $script:TunnelLogPath) {
            $addresses = @(Select-String -LiteralPath $script:TunnelLogPath -Pattern 'https://[^\s,]+devtunnels\.ms[^\s,]*' -AllMatches |
                ForEach-Object { $_.Matches } | ForEach-Object { $_.Value })
            # The browser address carries the port in the host name: https://<id>-<port>.<region>.devtunnels.ms
            $address = @($addresses | Where-Object { $_ -match "-$Port\." }) + $addresses | Select-Object -First 1
            if ($address) {
                return [pscustomobject]@{ Process = $process; Url = ($address.TrimEnd('/') + '/') }
            }
        }
        Start-Sleep -Milliseconds $script:PollIntervalInMilliseconds
    }

    $log = @($script:TunnelLogPath, "$script:TunnelLogPath.err") | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { Get-Content -LiteralPath $_ -Raw }
    if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    Exit-WithError "devtunnel host gave no address within $($script:TunnelStartTimeoutInSeconds)s. $($log -join ' ')" 4
}

function Resolve-BrowserPath {
    if ($BrowserPath) {
        if (-not (Test-Path -LiteralPath $BrowserPath)) { Exit-WithError "Browser not found: $BrowserPath" 3 }
        return $BrowserPath
    }

    $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) | Where-Object { $_ }
    $candidates = @($roots | ForEach-Object { Join-Path $_ $script:WindowsBrowserPaths[$Browser] }) + $script:OtherBrowserPaths[$Browser]

    foreach ($candidate in $candidates) {
        if ([System.IO.Path]::IsPathRooted($candidate) -and (Test-Path -LiteralPath $candidate)) { return $candidate }
        $command = Get-Command -Name $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { return $command.Source }
    }

    Exit-WithError "$Browser not found. Pass -BrowserPath." 3
}

function Wait-FirstBuild {
    param([Parameter(Mandatory)][datetime]$StartedAt)

    $marker = Join-Path $script:DistPath 'sw.js'
    $deadline = (Get-Date).AddSeconds($script:FirstBuildTimeoutInSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path -LiteralPath $marker) -and (Get-Item -LiteralPath $marker).LastWriteTime -ge $StartedAt) { return }
        Start-Sleep -Milliseconds $script:PollIntervalInMilliseconds
    }

    Exit-WithError "No build within $($script:FirstBuildTimeoutInSeconds)s. Run: node scripts/build.mjs" 1
}

function Get-LanAddresses {
    return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        ForEach-Object { $_.IPAddress })
}

# A self-signed certificate for this machine's names and LAN addresses, made once and kept in .certificates.
function Get-DebugCertificate {
    if (Test-Path -LiteralPath $script:CertificatePath) { return $script:CertificatePath }
    if (-not (Get-Command New-SelfSignedCertificate -ErrorAction SilentlyContinue)) {
        Exit-WithError 'New-SelfSignedCertificate is missing; -Lan needs Windows.' 3
    }

    $names = @('localhost', $env:COMPUTERNAME) + (Get-LanAddresses)
    $certificate = New-SelfSignedCertificate -DnsName $names -CertStoreLocation 'Cert:\CurrentUser\My' -FriendlyName 'Ether debug' -NotAfter (Get-Date).AddYears(1)
    try {
        $null = New-Item -ItemType Directory -Path $script:CertificateFolder -Force
        $password = ConvertTo-SecureString -String $script:CertificatePassword -Force -AsPlainText
        $null = Export-PfxCertificate -Cert $certificate -FilePath $script:CertificatePath -Password $password
    }
    finally {
        Remove-Item -Path "Cert:\CurrentUser\My\$($certificate.Thumbprint)" -Force
    }

    Write-Host "Created $script:CertificatePath for $($names -join ', ')" -ForegroundColor DarkGray
    return $script:CertificatePath
}

if ($RemoveTools) {
    Remove-DevTunnelTool
    exit 0
}

if ($Tunnel -and $Lan) { Exit-WithError 'Use -Tunnel or -Lan, not both.' 3 }

& (Join-Path $PSScriptRoot 'Invoke-Test.ps1') -InstallOnly | Out-Host
if ($LASTEXITCODE -ne 0) { Exit-WithError 'Node.js or the npm packages are not ready; see above.' 3 }

$devTunnelExecutable = $null
if ($Tunnel) {
    $devTunnelExecutable = Get-DevTunnelPath
    Write-Host "devtunnel: $devTunnelExecutable" -ForegroundColor DarkGray
}

if ($InstallOnly) { exit 0 }

Push-Location -LiteralPath $PSScriptRoot
$watcher = $null
$server = $null
$tunnelHost = $null
try {
    $nodePath = (Get-Command node).Source
    $startedAt = Get-Date

    if ($NoWatch) {
        & node $script:BuildScript
        if ($LASTEXITCODE -ne 0) { Exit-WithError 'Build failed.' 1 }
    }
    else {
        $watcher = Start-Process -FilePath $nodePath -ArgumentList "`"$script:BuildScript`" --watch" -NoNewWindow -PassThru
        Wait-FirstBuild -StartedAt $startedAt
    }

    $serverArguments = @("`"$script:ServeScript`"", '--port', $Port)
    $url = "http://localhost:$Port/"
    if ($Lan) {
        $certificatePath = Get-DebugCertificate
        $serverArguments += @('--host', '0.0.0.0', '--pfx', "`"$certificatePath`"", '--passphrase', $script:CertificatePassword)
        $lanAddress = Get-LanAddresses | Select-Object -First 1
        $url = if ($lanAddress) { "https://${lanAddress}:$Port/" } else { "https://localhost:$Port/" }
    }
    if ($Tunnel) {
        # The tunnel reaches the server through "localhost", which may resolve to either loopback.
        $serverArguments += @('--host', 'localhost')
    }

    $server = Start-Process -FilePath $nodePath -ArgumentList $serverArguments -NoNewWindow -PassThru

    if ($Tunnel) {
        Confirm-DevTunnelLogin -Executable $devTunnelExecutable
        $tunnelId = Get-TunnelId -Executable $devTunnelExecutable
        $tunnelHost = Start-TunnelHost -Executable $devTunnelExecutable -TunnelId $tunnelId
        $url = $tunnelHost.Url
    }

    if (-not $NoBrowser) {
        $browserExecutable = Resolve-BrowserPath
        $profiles = if ($Peers -eq 2) { @((Join-Path $ProfilePath 'a'), (Join-Path $ProfilePath 'b')) } else { @($ProfilePath) }
        foreach ($profileFolder in $profiles) {
            $null = New-Item -ItemType Directory -Path $profileFolder -Force
            $browserArguments = @(
                "--user-data-dir=`"$profileFolder`""
                '--no-first-run'
                '--no-default-browser-check'
                '--new-window'
                $url
            )
            if ($Lan) { $browserArguments = @('--ignore-certificate-errors') + $browserArguments }
            Start-Process -FilePath $browserExecutable -ArgumentList $browserArguments | Out-Null
        }

        Write-Host ''
        Write-Host "Browser: $browserExecutable" -ForegroundColor Cyan
        Write-Host "Profiles: $($profiles -join ', ')" -ForegroundColor DarkGray
    }

    Write-Host ''
    Write-Host "Open: $url" -ForegroundColor Cyan
    if ($Tunnel -or $Lan) {
        Write-Host 'Scan with the phone:' -ForegroundColor DarkGray
        & node $script:QrScript $url
        if ($Tunnel) {
            Write-Host 'The first visit shows a dev tunnels notice; tap Continue. Both devices must still share the Wi-Fi to transfer.' -ForegroundColor DarkGray
        }
    }
    if ($Peers -eq 2) {
        Write-Host 'Pair the windows: Show code in one, copy the code, Join with code in the other, then paste the answer back.' -ForegroundColor DarkGray
    }

    if ($NoWatch) {
        Write-Host 'Serving. Ctrl+C stops.' -ForegroundColor Cyan
        $server.WaitForExit()
        exit 0
    }

    Write-Host 'Watching for changes; reload the page after each rebuild. Ctrl+C stops.' -ForegroundColor Cyan
    $watcher.WaitForExit()
    exit 0
}
finally {
    if ($watcher -and -not $watcher.HasExited) { Stop-Process -Id $watcher.Id -Force }
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
    if ($tunnelHost -and -not $tunnelHost.Process.HasExited) { Stop-Process -Id $tunnelHost.Process.Id -Force }
    Pop-Location
}
