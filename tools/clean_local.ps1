param(
    [switch]$Execute,
    [switch]$IncludeVenv,
    [switch]$IncludeOutput
)

$paths = @(
    "build",
    "dist",
    "__pycache__",
    "backend/__pycache__",
    "temp_uploads",
    ".snapshots",
    "temp_web",
    "temp_web_check",
    "_darkfix",
    "_djtransport",
    "_djwave",
    "_final3",
    "_reactivity",
    "_settingscompact",
    "_svgonly"
)

if ($IncludeVenv) { $paths += @("venv", ".venv") }
if ($IncludeOutput) { $paths += "output" }

foreach ($path in $paths) {
    if (-not (Test-Path $path)) { continue }
    if ($Execute) {
        Remove-Item -Recurse -Force -Path $path
        Write-Host "Removed: $path"
    } else {
        Write-Host "Would remove: $path"
    }
}

if (-not $Execute) {
    Write-Host "Dry run complete. Re-run with -Execute to delete."
}
