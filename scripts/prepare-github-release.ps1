[CmdletBinding()]
param(
    [string]$Destination = "",
    [switch]$InitGit
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Destination)) {
    $Destination = Join-Path (Split-Path -Parent $repoRoot) "omnicrawl-github"
}

$destinationPath = [System.IO.Path]::GetFullPath($Destination)

if (Test-Path -LiteralPath $destinationPath) {
    $existingEntries = Get-ChildItem -Force -LiteralPath $destinationPath
    if ($existingEntries.Count -gt 0) {
        throw "Destination already exists and is not empty: $destinationPath"
    }
} else {
    New-Item -ItemType Directory -Path $destinationPath | Out-Null
}

$excludeNames = @(
    ".git",
    ".omnicrawl",
    "node_modules",
    "runs",
    "coverage",
    ".nyc_output",
    "logs",
    "tmp"
)

$excludeFilePatterns = @(
    "*.log",
    "*.sqlite",
    "*.db",
    "*.tgz",
    ".env",
    ".env.*"
)

function Test-ShouldExcludePath {
    param(
        [System.IO.FileSystemInfo]$Item
    )

    if ($excludeNames -contains $Item.Name) {
        return $true
    }

    foreach ($pattern in $excludeFilePatterns) {
        if ($Item.Name -like $pattern) {
            if ($Item.Name -eq ".env.example") {
                return $false
            }
            return $true
        }
    }

    return $false
}

function Copy-RepoTree {
    param(
        [string]$SourcePath,
        [string]$TargetPath
    )

    Get-ChildItem -Force -LiteralPath $SourcePath | ForEach-Object {
        if (Test-ShouldExcludePath $_) {
            return
        }

        $nextTarget = Join-Path $TargetPath $_.Name

        if ($_.PSIsContainer) {
            New-Item -ItemType Directory -Path $nextTarget -Force | Out-Null
            Copy-RepoTree -SourcePath $_.FullName -TargetPath $nextTarget
            return
        }

        Copy-Item -LiteralPath $_.FullName -Destination $nextTarget -Force
    }
}

Copy-RepoTree -SourcePath $repoRoot -TargetPath $destinationPath

if ($InitGit) {
    $gitDir = Join-Path $destinationPath ".git"
    if (-not (Test-Path -LiteralPath $gitDir)) {
        & git -C $destinationPath init --initial-branch=main | Out-Null
    }
}

Write-Host "Prepared clean GitHub release copy at: $destinationPath"
if ($InitGit) {
    Write-Host "Initialized a new git repository in the destination directory."
}
