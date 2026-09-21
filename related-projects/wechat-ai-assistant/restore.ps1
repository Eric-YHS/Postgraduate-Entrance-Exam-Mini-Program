$ErrorActionPreference = 'Stop'

$outputPath = Join-Path $PSScriptRoot '微信AI助手_1.2.0.zip'
$parts = Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot 'distribution') -File -Filter '*.part*' |
    Sort-Object Name

if (-not $parts) {
    throw '未找到分片文件。'
}

$output = [System.IO.File]::Create($outputPath)
try {
    foreach ($part in $parts) {
        $input = [System.IO.File]::OpenRead($part.FullName)
        try {
            $input.CopyTo($output)
        }
        finally {
            $input.Dispose()
        }
    }
}
finally {
    $output.Dispose()
}

$expected = 'A24B68A7710118B2F7BE7F45BFF253B13E65D6B44A1520EA4399B37F4AD8E0BB'
$actual = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash
if ($actual -ne $expected) {
    throw "校验失败：$actual"
}

Write-Host "已恢复并校验：$outputPath"
