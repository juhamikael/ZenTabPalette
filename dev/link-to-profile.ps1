<#
  dev/link-to-profile.ps1
  Symlink ZenTabPalette's files into your Zen profile for live development, so edits in
  this repo are picked up by the browser. Supports BOTH loaders:

    * Sine          - mod files live in <profile>\chrome\sine-mods\<id>\
    * fx-autoconfig - script + style live in <profile>\chrome\JS\

  The script auto-detects which loader is installed (Sine if <profile>\chrome\JS\
  sine.sys.mjs exists, otherwise fx-autoconfig) and links into the right place.

  REQUIREMENTS (Windows): symlink creation needs Developer Mode ON
  (Settings > System > For developers) OR an elevated shell.

  Close Zen before running (the loaders read these on startup; Sine may rewrite its
  folder while running).

  USAGE:
    .\dev\link-to-profile.ps1                         # auto-detect profile + loader
    .\dev\link-to-profile.ps1 -ProfileChrome "<path>" # point at <profile>\chrome explicitly
    .\dev\link-to-profile.ps1 -Loader sine            # force a loader (sine | fxac)
    .\dev\link-to-profile.ps1 -Unlink                 # restore plain copies

  SINE NOTE: install the mod once via Sine first (Sine settings > marketplace, paste the
  repo, or add it as a local/unpublished mod) so it is registered in mods.json and its
  folder exists. This script then symlinks the repo files OVER the installed copy for live
  editing - it does not touch Sine's mods.json registry.
#>
param(
  [string]$ProfileChrome,                         # <your Zen profile>\chrome ; auto-detected if omitted
  [ValidateSet("auto", "sine", "fxac")] [string]$Loader = "auto",
  [switch]$Unlink
)
$ErrorActionPreference = "Stop"
$repo = Split-Path $PSScriptRoot -Parent

# The two functional files Zen actually loads, plus the Sine manifest.
$jsFiles    = @("tab-filter.uc.js", "tab-filter.css")
$sineExtras = @("theme.json")                    # only needed by Sine
if (Test-Path (Join-Path $repo "preferences.json")) { $sineExtras += "preferences.json" }

function Find-ZenProfileChrome {
  $roots = @()
  if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA "zen") }
  if ($env:HOME) { $roots += (Join-Path $env:HOME "Library/Application Support/zen"); $roots += (Join-Path $env:HOME ".zen") }
  $root = $roots | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $root) { return $null }
  $ini = Join-Path $root "profiles.ini"
  if (Test-Path $ini) {
    $def = Get-Content $ini | Select-String -Pattern '^\s*Default\s*=\s*(.+?)\s*$' |
           Where-Object { $_.Matches[0].Groups[1].Value -match '[\\/]' } | Select-Object -First 1
    if ($def) {
      $p = Join-Path $root ($def.Matches[0].Groups[1].Value -replace '/', '\')
      if (Test-Path $p) { return (Join-Path $p "chrome") }
    }
  }
  $profiles = Join-Path $root "Profiles"
  if (Test-Path $profiles) {
    $newest = Get-ChildItem $profiles -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { return (Join-Path $newest.FullName "chrome") }
  }
  return $null
}

if (-not $ProfileChrome) {
  $ProfileChrome = Find-ZenProfileChrome
  if (-not $ProfileChrome) {
    Write-Host "Could not auto-detect your Zen profile. Open Zen > about:profiles, copy the"
    Write-Host "profile's Root Directory, then run: .\dev\link-to-profile.ps1 -ProfileChrome '<that>\chrome'"
    exit 1
  }
}
Write-Host "Profile chrome: $ProfileChrome"

# Detect the loader.
if ($Loader -eq "auto") {
  $Loader = if (Test-Path (Join-Path $ProfileChrome "JS\sine.sys.mjs")) { "sine" } else { "fxac" }
}
Write-Host "Loader: $Loader"

# Resolve the target dir + which files to link for this loader.
if ($Loader -eq "sine") {
  $themeJson = Join-Path $repo "theme.json"
  if (-not (Test-Path $themeJson)) { throw "theme.json missing - needed for the Sine layout." }
  $modId = (Get-Content $themeJson -Raw | ConvertFrom-Json).id
  if (-not $modId) { throw "theme.json has no 'id'." }
  $target = Join-Path $ProfileChrome "sine-mods\$modId"
  if (-not $Unlink -and -not (Test-Path $target)) {
    Write-Host "Sine mod folder not found: $target"
    Write-Host "Install the mod via Sine once (so it registers in mods.json and creates the"
    Write-Host "folder), then re-run this to symlink the repo files over it for live editing."
    exit 1
  }
  $files = $jsFiles + $sineExtras
} else {
  $target = Join-Path $ProfileChrome "JS"
  $files = $jsFiles
}
if (-not (Test-Path $target)) { New-Item -ItemType Directory -Force -Path $target | Out-Null }
$backup = Join-Path $target ("_pre-symlink-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

foreach ($f in $files) {
  $src  = Join-Path $repo $f
  $link = Join-Path $target $f
  if (-not (Test-Path $src)) { Write-Host "skip (no source in repo): $f"; continue }

  $existing = Get-Item $link -Force -ErrorAction SilentlyContinue
  if ($Unlink) {
    if ($existing -and $existing.LinkType -eq "SymbolicLink") { Remove-Item $link -Force; Copy-Item $src $link -Force; Write-Host "unlinked (copied): $f" }
    continue
  }
  if ($existing) {
    if ($existing.LinkType -eq "SymbolicLink") {
      Remove-Item $link -Force
    } else {
      New-Item -ItemType Directory -Force -Path $backup | Out-Null
      Move-Item $link (Join-Path $backup $f) -Force
      Write-Host "backed up existing file: $f"
    }
  }
  try {
    New-Item -ItemType SymbolicLink -Path $link -Target $src | Out-Null
    Write-Host "linked: $f  ->  $src"
  } catch {
    Write-Host "FAILED to symlink $f. Enable Developer Mode or run from an elevated shell."
    throw
  }
}

Write-Host ""
if ($Unlink) { Write-Host "Unlinked. The profile holds plain copies again." }
else { Write-Host "Done ($Loader). Restart Zen (about:profiles > Restart normally) to pick up changes." }
