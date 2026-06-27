<#
  dev/link-to-profile.ps1
  Symlink ZenTabPalette's files into your Zen Browser profile so Zen loads them
  straight from this repo. Develop here; edits are reflected live through the
  symlinks (no copying back and forth).

  REQUIREMENTS (Windows):
    - fx-autoconfig already installed (see README.md "Install").
    - Symlink creation needs EITHER Developer Mode ON
      (Settings > System > For developers > Developer Mode), OR an elevated shell.

  USAGE:
    # Auto-detect your default Zen profile:
    .\dev\link-to-profile.ps1

    # Or point it at your profile's chrome\JS folder explicitly
    # (find the profile via Zen: about:support > "Open Profile Folder"):
    .\dev\link-to-profile.ps1 -ProfileJS "C:\path\to\zen\Profiles\xxxx\chrome\JS"

    # Undo (replace the symlinks with plain copies again):
    .\dev\link-to-profile.ps1 -Unlink

  Non-Windows: PowerShell 7 runs on macOS/Linux; pass -ProfileJS pointing at your
  profile's chrome/JS. Or just copy tab-filter.uc.js + tab-filter.css there manually.
#>
param(
  [string]$ProfileJS,   # path to <your Zen profile>\chrome\JS ; auto-detected if omitted
  [switch]$Unlink
)
$ErrorActionPreference = "Stop"

# Repo root is the parent of this dev/ folder. Only the two functional files are
# loaded by Zen; the docs stay in the repo.
$repo  = Split-Path $PSScriptRoot -Parent
$files = @("tab-filter.uc.js", "tab-filter.css")

function Find-ZenProfileJS {
  # Windows: %APPDATA%\zen ; macOS: ~/Library/Application Support/zen ; Linux: ~/.zen
  $candidates = @()
  if ($env:APPDATA) { $candidates += (Join-Path $env:APPDATA "zen") }
  if ($env:HOME) {
    $candidates += (Join-Path $env:HOME "Library/Application Support/zen")
    $candidates += (Join-Path $env:HOME ".zen")
  }
  $root = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $root) { return $null }

  # Prefer the default profile from profiles.ini, else the most-recently-used profile dir.
  $ini = Join-Path $root "profiles.ini"
  if (Test-Path $ini) {
    $def = Get-Content $ini | Select-String -Pattern '^\s*Default\s*=\s*(.+?)\s*$' |
           Where-Object { $_.Matches[0].Groups[1].Value -match '[\\/]' } | Select-Object -First 1
    if ($def) {
      $rel = $def.Matches[0].Groups[1].Value -replace '/', '\'
      $p = Join-Path $root $rel
      if (Test-Path $p) { return (Join-Path $p "chrome\JS") }
    }
  }
  $profiles = Join-Path $root "Profiles"
  if (Test-Path $profiles) {
    $newest = Get-ChildItem $profiles -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) { return (Join-Path $newest.FullName "chrome\JS") }
  }
  return $null
}

if (-not $ProfileJS) {
  $ProfileJS = Find-ZenProfileJS
  if (-not $ProfileJS) {
    Write-Host "Could not auto-detect your Zen profile."
    Write-Host "Open Zen > about:support > 'Open Profile Folder', then run:"
    Write-Host "  .\dev\link-to-profile.ps1 -ProfileJS '<that folder>\chrome\JS'"
    exit 1
  }
  Write-Host "Auto-detected profile: $ProfileJS"
}

if (-not (Test-Path $ProfileJS)) { New-Item -ItemType Directory -Force -Path $ProfileJS | Out-Null }
$backup = Join-Path $ProfileJS ("_pre-symlink-backup-" + (Get-Date -Format "yyyyMMdd-HHmmss"))

foreach ($f in $files) {
  $target = Join-Path $repo $f         # the real file (in the repo)
  $link   = Join-Path $ProfileJS $f    # where Zen looks for it
  if (-not (Test-Path $target)) { Write-Host "skip (no source in repo): $f"; continue }

  $existing = Get-Item $link -Force -ErrorAction SilentlyContinue

  if ($Unlink) {
    if ($existing -and $existing.LinkType -eq "SymbolicLink") { Remove-Item $link -Force; Copy-Item $target $link -Force; Write-Host "unlinked (copied): $f" }
    continue
  }

  if ($existing) {
    if ($existing.LinkType -eq "SymbolicLink") {
      Remove-Item $link -Force                 # recreate (idempotent)
    } else {
      New-Item -ItemType Directory -Force -Path $backup | Out-Null
      Move-Item $link (Join-Path $backup $f) -Force
      Write-Host "backed up existing file: $f  ->  $backup"
    }
  }

  try {
    New-Item -ItemType SymbolicLink -Path $link -Target $target | Out-Null
    Write-Host "linked: $f  ->  $target"
  } catch {
    Write-Host "FAILED to symlink $f. Enable Developer Mode or run this from an elevated shell."
    throw
  }
}

Write-Host ""
if ($Unlink) { Write-Host "Unlinked. The profile holds plain copies again." }
else { Write-Host "Done. Reload Zen (close fully, wait for the process to exit, then start)." }
