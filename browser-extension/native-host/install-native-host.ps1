param(
    [string]$AppExe = "",
    [string]$ExtensionId = "",
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$hostName = "com.yunx.mini"
$edgeKey = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
$chromeKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$installDir = Join-Path $env:LOCALAPPDATA "YunX-Fetch\native-host"

if ($Uninstall) {
    foreach ($key in @($edgeKey, $chromeKey)) {
        if (Test-Path $key) { Remove-Item $key -Recurse -Force }
    }
    if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
    Write-Host "[OK] 已移除 YunX Fetch native host 注册"
    exit 0
}

if (-not $ExtensionId) {
    $idFile = Join-Path $PSScriptRoot "..\EXTENSION_ID"
    if (Test-Path $idFile) {
        $ExtensionId = (Get-Content $idFile -Raw).Trim()
    }
}
if (-not $ExtensionId) {
    throw "缺少扩展 ID：请传入 -ExtensionId 或在 browser-extension/EXTENSION_ID 中写入固定 ID"
}

if (-not $AppExe) {
    $candidates = @(
        (Join-Path $PSScriptRoot "..\YunX-WIN.exe"),
        (Join-Path $PSScriptRoot "..\..\release\YunX-WIN\YunX-WIN.exe"),
        (Join-Path $PSScriptRoot "..\..\build\YunX-WIN\YunX-WIN.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\YunX-WIN\YunX-WIN.exe")
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $AppExe = (Resolve-Path $candidate).Path; break }
    }
}
if (-not $AppExe -or -not (Test-Path $AppExe)) {
    throw "找不到 YunX-WIN.exe：请传入 -AppExe，例如 -AppExe 'C:\...\YunX-WIN.exe'"
}
$AppExe = (Resolve-Path $AppExe).Path

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$hostExe = Join-Path $installDir "YunX-MiniHost.exe"

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    throw "找不到 csc.exe（.NET Framework 4.x），无法编译 native host"
}

& $csc /nologo /target:winexe /platform:x64 "/out:$hostExe" (Join-Path $PSScriptRoot "YunX-MiniHost.cs")
if ($LASTEXITCODE -ne 0) { throw "native host 编译失败" }

$config = @{ appExe = $AppExe; miniArgs = @("--mini") } | ConvertTo-Json -Compress
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $installDir "host.config.json"), $config, $utf8NoBom)

$manifest = Get-Content (Join-Path $PSScriptRoot "com.yunx.mini.json.in") -Raw
$manifest = $manifest.Replace("__HOST_PATH__", $hostExe.Replace("\", "\\"))
$manifest = $manifest.Replace("__EXTENSION_ID__", $ExtensionId)
$manifestPath = Join-Path $installDir "$hostName.json"
[System.IO.File]::WriteAllText($manifestPath, $manifest, $utf8NoBom)

foreach ($key in @($edgeKey, $chromeKey)) {
    New-Item -Path $key -Force | Out-Null
    Set-Item -Path $key -Value $manifestPath
}

Write-Host "[OK] native host 已注册"
Write-Host "     扩展 ID : $ExtensionId"
Write-Host "     Host    : $hostExe"
Write-Host "     清单     : $manifestPath"
Write-Host "     App     : $AppExe"
Write-Host "     在 Edge / Chrome 中重新加载扩展后生效。"
