# postbuild.ps1 - embed icon and version info into FlowPaper.exe after packaging
# Reason: electron-builder's signAndEditExecutable needs winCodeSign which fails
#         to extract (symlink requires admin privileges). Use rcedit manually.

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$rcedit = Join-Path $root 'tools\rcedit-x64.exe'
$ico = Join-Path $root 'build\icon.ico'

if (-not (Test-Path $rcedit)) { Write-Error "rcedit not found: $rcedit"; exit 1 }
if (-not (Test-Path $ico)) { Write-Error "icon not found: $ico"; exit 1 }

$exes = Get-ChildItem $root -Recurse -Filter 'FlowPaper.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like '*\dist-*\win-unpacked\FlowPaper.exe' }

if (-not $exes) { Write-Output 'No FlowPaper.exe found, skip icon embedding'; exit 0 }

foreach ($exe in $exes) {
    & $rcedit $exe.FullName `
        --set-icon $ico `
        --set-version-string 'ProductName' 'FlowPaper' `
        --set-version-string 'FileDescription' 'FlowPaper' `
        --set-version-string 'CompanyName' 'FlowPaper' `
        --set-version-string 'LegalCopyright' 'Copyright (C) 2026' `
        --set-file-version '1.1.1.0' `
        --set-product-version '1.1.1.0'

    if ($LASTEXITCODE -ne 0) { Write-Error "rcedit failed: $($exe.FullName)"; exit 1 }
    Write-Output "Icon embedded: $($exe.FullName)"
}

Write-Output 'postbuild done'
