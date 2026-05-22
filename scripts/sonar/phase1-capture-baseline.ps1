param(
  [string]$ProjectKey = "ima-jin_imajin-ai",
  [string]$OutFile = "artifacts/sonar/phase1-baseline.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$baseUrl = "https://sonarcloud.io"

function Get-Json {
  param([string]$Path)
  Invoke-RestMethod -Method Get -Uri "$baseUrl$Path"
}

function Get-FileMeasures {
  param([string]$MetricKeys)

  $rows = @()
  $page = 1
  do {
    $encodedProject = [uri]::EscapeDataString($ProjectKey)
    $encodedMetrics = [uri]::EscapeDataString($MetricKeys)
    $url = "/api/measures/component_tree?component=$encodedProject&metricKeys=$encodedMetrics&qualifiers=FIL&ps=500&p=$page"
    $resp = Get-Json -Path $url

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
        new_duplicated_lines_density = $(if ($m.ContainsKey("new_duplicated_lines_density")) { $m["new_duplicated_lines_density"] } else { 0 })
        new_bugs = $(if ($m.ContainsKey("new_bugs")) { $m["new_bugs"] } else { 0 })
        new_vulnerabilities = $(if ($m.ContainsKey("new_vulnerabilities")) { $m["new_vulnerabilities"] } else { 0 })
        new_code_smells = $(if ($m.ContainsKey("new_code_smells")) { $m["new_code_smells"] } else { 0 })
      }
    }

    $page++
  } while ((($page - 1) * 500) -lt $resp.paging.total)

  return $rows
}

$status = Get-Json -Path "/api/qualitygates/project_status?projectKey=$([uri]::EscapeDataString($ProjectKey))"
$measures = Get-Json -Path "/api/measures/component?component=$([uri]::EscapeDataString($ProjectKey))&metricKeys=alert_status,duplicated_lines_density,coverage,new_coverage,new_duplicated_lines_density,code_smells,new_code_smells,bugs,new_bugs,vulnerabilities,new_vulnerabilities,reliability_rating,security_rating,sqale_rating"
$hotspots = Get-Json -Path "/api/hotspots/search?projectKey=$([uri]::EscapeDataString($ProjectKey))&inNewCodePeriod=true&ps=500"
$fileMeasures = Get-FileMeasures -MetricKeys "new_duplicated_lines_density,new_bugs,new_vulnerabilities,new_code_smells"

$topDup = $fileMeasures | Where-Object { $_.new_duplicated_lines_density -gt 0 } | Sort-Object new_duplicated_lines_density -Descending | Select-Object -First 25
$topNewBugs = $fileMeasures | Where-Object { $_.new_bugs -gt 0 } | Sort-Object new_bugs -Descending | Select-Object -First 25
$topNewVulns = $fileMeasures | Where-Object { $_.new_vulnerabilities -gt 0 } | Sort-Object new_vulnerabilities -Descending | Select-Object -First 25
$topNewSmells = $fileMeasures | Where-Object { $_.new_code_smells -gt 0 } | Sort-Object new_code_smells -Descending | Select-Object -First 25
$hotspotsByRule = $hotspots.hotspots | Group-Object ruleKey | Sort-Object Count -Descending | ForEach-Object { [PSCustomObject]@{ rule = $_.Name; count = $_.Count } }

$baseline = [PSCustomObject]@{
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  projectKey = $ProjectKey
  qualityGateStatus = $status.projectStatus.status
  qualityGateConditions = $status.projectStatus.conditions
  headlineMeasures = $measures.component.measures
  newCodeHotspotsTotal = $hotspots.paging.total
  newCodeHotspotsByRule = $hotspotsByRule
  topNewDuplicationFiles = $topDup
  topNewBugFiles = $topNewBugs
  topNewVulnerabilityFiles = $topNewVulns
  topNewCodeSmellFiles = $topNewSmells
}

$outDir = Split-Path -Parent $OutFile
if ($outDir) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$baseline | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 -Path $OutFile
Write-Host "Wrote baseline snapshot to $OutFile"
