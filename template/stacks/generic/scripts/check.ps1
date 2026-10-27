# Project checks. Replace with real tests; keep the exit code meaningful (non-zero = failed).
$ErrorActionPreference = 'Stop'
$bad = git ls-files | Where-Object { $_ -match '(^|/)\.env($|\.)|\.(pem|key)$' -and $_ -notmatch '\.env\.example$' }
if ($bad) { Write-Error "secret-looking files are tracked: $bad"; exit 1 }
Write-Output 'checks passed'
