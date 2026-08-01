$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$stage = Join-Path $root '.build\stage'
$zip = Join-Path $root 'nekto-pro.zip'

$files = @(
    'background.js',
    'inject-bootstrap.js',
    'nekto-pro-inject.js',
    'vosk-lib.js',
    'vosk-model-ru.tar.gz',
    'icon.png',
    'manifest.json'
)

if (Test-Path -LiteralPath $stage) {
    Remove-Item -LiteralPath $stage -Recurse -Force
}
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($f in $files) {
    Copy-Item -LiteralPath (Join-Path $root $f) -Destination (Join-Path $stage $f) -Force
}

if (Test-Path -LiteralPath $zip) {
    Remove-Item -LiteralPath $zip -Force
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$fs = [System.IO.File]::Create($zip)
$arch = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $stage -File | ForEach-Object {
        $entry = $arch.CreateEntry($_.Name, [System.IO.Compression.CompressionLevel]::Optimal)
        $es = $entry.Open()
        try {
            $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
            $es.Write($bytes, 0, $bytes.Length)
        } finally {
            $es.Dispose()
        }
    }
} finally {
    $arch.Dispose()
    $fs.Dispose()
}

Write-Host "OK: $zip"
