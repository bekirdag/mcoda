$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$nodeBin = if ($env:NODE_BIN) { $env:NODE_BIN } else { "node" }

Set-Location $root
& $nodeBin (Join-Path $root "tests" "all.js") @args
exit $LASTEXITCODE
