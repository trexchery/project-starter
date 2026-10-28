# Project checks. Add this language's real test commands below (e.g. 'go test ./...', 'cargo test',
# 'dotnet test'). Until at least one is listed, this check FAILS on purpose: a placeholder never verifies anything.
$tests = @(
)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)  # the repository root, wherever this is started from
$bad = git ls-files | Where-Object { $_ -match '(^|/)\.env($|\.)|\.(pem|key)$' -and $_ -notmatch '\.env\.example$' }
if ($bad) { Write-Error "secret-looking files are tracked: $bad"; exit 1 }
if ($tests.Count -eq 0) {
  [Console]::Error.WriteLine('NOT VERIFIED: no tests configured. Add the real test command to $tests in scripts/check.ps1.')
  exit 2
}
foreach ($t in $tests) {
  Write-Output "> $t"
  Invoke-Expression $t
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
}
Write-Output 'checks passed'
