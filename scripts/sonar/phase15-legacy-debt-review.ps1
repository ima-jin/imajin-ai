param(
  [string]$ProjectKey = "ima-jin_imajin-ai",
  [string]$Organization = "ima-jin",
  [string]$OutFile = "artifacts/sonar/phase15-legacy-debt-review.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$baseUrl = "https://sonarcloud.io"
$headers = @{}
if ($env:SONAR_TOKEN) {
  $pair = "$($env:SONAR_TOKEN):"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
  $headers = @{ Authorization = "Basic $encoded" }
}

function Invoke-SonarGet {
  param(
    [string]$Path,
    [hashtable]$Query = @{}
  )

  $qs = @()
  foreach ($k in $Query.Keys) {
    $qs += ("{0}={1}" -f [uri]::EscapeDataString($k), [uri]::EscapeDataString([string]$Query[$k]))
  }
  $url = if ($qs.Count -gt 0) { "{0}{1}?{2}" -f $baseUrl, $Path, ($qs -join '&') } else { "{0}{1}" -f $baseUrl, $Path }

  if ($headers.Count -gt 0) {
    return Invoke-RestMethod -Method Get -Uri $url -Headers $headers
  }
  return Invoke-RestMethod -Method Get -Uri $url
}

function Get-Issues {
  param(
    [hashtable]$ExtraQuery = @{}
  )

  $all = @()
  $page = 1
  do {
    $query = @{
      organization = $Organization
      componentKeys = $ProjectKey
      resolved = "false"
      types = "BUG,VULNERABILITY,CODE_SMELL"
      ps = 500
      p = $page
    }
    foreach ($k in $ExtraQuery.Keys) {
      $query[$k] = $ExtraQuery[$k]
    }

    $resp = Invoke-SonarGet -Path "/api/issues/search" -Query $query
    foreach ($i in $resp.issues) { $all += $i }
    $page++
  } while ((($page - 1) * 500) -lt $resp.paging.total)

  return $all
}

function Get-Hotspots {
  param(
    [hashtable]$ExtraQuery = @{}
  )

  $all = @()
  $componentMap = @{}
  $page = 1
  do {
    $query = @{
      projectKey = $ProjectKey
      status = "TO_REVIEW"
      ps = 500
      p = $page
    }
    foreach ($k in $ExtraQuery.Keys) {
      $query[$k] = $ExtraQuery[$k]
    }

    $resp = Invoke-SonarGet -Path "/api/hotspots/search" -Query $query
    if ($resp.components) {
      foreach ($c in $resp.components) {
        $resolvedPath = ""
        if (($c.PSObject.Properties.Name -contains "path") -and $c.path) {
          $resolvedPath = $c.path
        } elseif (($c.PSObject.Properties.Name -contains "longName") -and $c.longName) {
          $resolvedPath = $c.longName
        } elseif (($c.PSObject.Properties.Name -contains "name") -and $c.name) {
          $resolvedPath = $c.name
        } else {
          $resolvedPath = $c.key
        }
        $componentMap[$c.key] = $resolvedPath
      }
    }
    foreach ($h in $resp.hotspots) { $all += $h }
    $page++
  } while ((($page - 1) * 500) -lt $resp.paging.total)

  return [PSCustomObject]@{
    hotspots = $all
    componentMap = $componentMap
  }
}

function Get-FileMeasureRows {
  param(
    [string]$MetricKeys
  )

  $rows = @()
  $page = 1
  do {
    $resp = Invoke-SonarGet -Path "/api/measures/component_tree" -Query @{
      component = $ProjectKey
      metricKeys = $MetricKeys
      qualifiers = "FIL"
      ps = 500
      p = $page
    }

    foreach ($c in $resp.components) {
      $m = @{}
      foreach ($measure in $c.measures) {
        $hasValue = $measure.PSObject.Properties.Name -contains "value"
        $hasPeriods = $measure.PSObject.Properties.Name -contains "periods"

        if ($hasValue -and $measure.value) {
          $val = $measure.value
        } elseif ($hasPeriods -and $measure.periods -and $measure.periods.Count -gt 0) {
          $val = $measure.periods[0].value
        } else {
          $val = "0"
        }

        $m[$measure.metric] = [double]$val
      }

      $rows += [PSCustomObject]@{
        path = $c.path
        duplicated_lines_density = $(if ($m.ContainsKey("duplicated_lines_density")) { $m["duplicated_lines_density"] } else { 0 })
        new_duplicated_lines_density = $(if ($m.ContainsKey("new_duplicated_lines_density")) { $m["new_duplicated_lines_density"] } else { 0 })
        code_smells = $(if ($m.ContainsKey("code_smells")) { $m["code_smells"] } else { 0 })
        new_code_smells = $(if ($m.ContainsKey("new_code_smells")) { $m["new_code_smells"] } else { 0 })
      }
    }
    $page++
  } while ((($page - 1) * 500) -lt $resp.paging.total)

  return $rows
}

function Get-IssuePath {
  param([string]$Component)
  if (-not $Component) { return "" }
  $parts = $Component -split ":", 2
  if ($parts.Count -eq 2) { return $parts[1] }
  return $Component
}

$allOpenIssues = Get-Issues
$newOpenIssues = Get-Issues -ExtraQuery @{ sinceLeakPeriod = "true" }

$newIssueKeySet = @{}
foreach ($i in $newOpenIssues) { $newIssueKeySet[$i.key] = $true }
$legacyIssues = @()
foreach ($i in $allOpenIssues) {
  if (-not $newIssueKeySet.ContainsKey($i.key)) { $legacyIssues += $i }
}

$laneA = $legacyIssues | Where-Object { $_.type -eq "BUG" -or $_.type -eq "VULNERABILITY" }
$laneCCodeSmells = $legacyIssues | Where-Object { $_.type -eq "CODE_SMELL" }

$allHotspotData = Get-Hotspots
$newHotspotData = Get-Hotspots -ExtraQuery @{ sinceLeakPeriod = "true" }
$newHotspotKeySet = @{}
foreach ($h in $newHotspotData.hotspots) { $newHotspotKeySet[$h.key] = $true }
$legacyHotspots = @()
foreach ($h in $allHotspotData.hotspots) {
  if (-not $newHotspotKeySet.ContainsKey($h.key)) { $legacyHotspots += $h }
}

$fileRows = Get-FileMeasureRows -MetricKeys "duplicated_lines_density,new_duplicated_lines_density,code_smells,new_code_smells"
$laneCDup = $fileRows | Where-Object { $_.duplicated_lines_density -gt 0 -and $_.new_duplicated_lines_density -eq 0 } | Sort-Object duplicated_lines_density -Descending | Select-Object -First 40
$laneCSmellFiles = $fileRows | Where-Object { $_.code_smells -gt 0 -and $_.new_code_smells -eq 0 } | Sort-Object code_smells -Descending | Select-Object -First 40

$laneAByFile = $laneA | ForEach-Object {
  [PSCustomObject]@{
    path = (Get-IssuePath -Component $_.component)
    type = $_.type
  }
} | Group-Object path | Sort-Object Count -Descending | Select-Object -First 40 | ForEach-Object {
  [PSCustomObject]@{ path = $_.Name; count = $_.Count }
}

$laneBByRule = $legacyHotspots | Group-Object ruleKey | Sort-Object Count -Descending | ForEach-Object {
  [PSCustomObject]@{ rule = $_.Name; count = $_.Count }
}

$laneBByFile = $legacyHotspots | ForEach-Object {
  $path = ""
  if ($allHotspotData.componentMap.ContainsKey($_.component)) { $path = $allHotspotData.componentMap[$_.component] } else { $path = $_.component }
  [PSCustomObject]@{ path = $path }
} | Group-Object path | Sort-Object Count -Descending | Select-Object -First 40 | ForEach-Object {
  [PSCustomObject]@{ path = $_.Name; count = $_.Count }
}

$laneAFirstBatch = $laneAByFile | Select-Object -First 10
$laneBFirstBatch = $laneBByFile | Select-Object -First 10
$laneCFirstBatch = $laneCDup | Select-Object -First 10 path,duplicated_lines_density

$result = [PSCustomObject]@{
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  projectKey = $ProjectKey
  counts = [PSCustomObject]@{
    openIssuesAll = $allOpenIssues.Count
    openIssuesNew = $newOpenIssues.Count
    openIssuesLegacy = $legacyIssues.Count
    laneA_legacyBugsAndVulns = $laneA.Count
    laneB_legacyHotspotsToReview = $legacyHotspots.Count
    laneC_legacyCodeSmells = $laneCCodeSmells.Count
  }
  laneA = [PSCustomObject]@{
    topFiles = $laneAByFile
    firstBatch = $laneAFirstBatch
  }
  laneB = [PSCustomObject]@{
    byRule = $laneBByRule
    topFiles = $laneBByFile
    firstBatch = $laneBFirstBatch
  }
  laneC = [PSCustomObject]@{
    topLegacyDuplicationFiles = $laneCDup
    topLegacyCodeSmellFiles = $laneCSmellFiles
    firstBatch = $laneCFirstBatch
  }
}

$outDir = Split-Path -Parent $OutFile
if ($outDir) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$result | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -Path $OutFile
Write-Host "Wrote legacy debt review to $OutFile"
