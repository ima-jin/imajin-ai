param(
  [string]$ProjectKey = "ima-jin_imajin-ai",
  [string]$Organization = "ima-jin",
  [string]$ReferenceBranch = "main",
  [int]$NewCoverageThreshold = 80
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $env:SONAR_TOKEN) {
  throw "SONAR_TOKEN is required to run Phase 1 policy lock-in."
}

$baseUrl = "https://sonarcloud.io"
$pair = "$($env:SONAR_TOKEN):"
$encoded = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($pair))
$headers = @{ Authorization = "Basic $encoded" }

function Invoke-SonarApi {
  param(
    [string]$Method,
    [string]$Path,
    [hashtable]$Query = @{},
    [hashtable]$Body = @{}
  )

  $qs = @()
  foreach ($key in $Query.Keys) {
    $qs += ("{0}={1}" -f [uri]::EscapeDataString($key), [uri]::EscapeDataString([string]$Query[$key]))
  }
  $url = if ($qs.Count -gt 0) { "{0}{1}?{2}" -f $baseUrl, $Path, ($qs -join '&') } else { "{0}{1}" -f $baseUrl, $Path }

  if ($Method -eq "GET") {
    return Invoke-RestMethod -Method Get -Uri $url -Headers $headers
  }

  return Invoke-RestMethod -Method Post -Uri $url -Headers $headers -Body $Body -ContentType "application/x-www-form-urlencoded"
}

$webServices = Invoke-SonarApi -Method "GET" -Path "/api/webservices/list"
$hasNewCodePeriodsApi = $false
foreach ($svc in $webServices.webServices) {
  if ($svc.path -eq "api/new_code_periods") {
    $hasNewCodePeriodsApi = $true
    break
  }
}

if ($hasNewCodePeriodsApi) {
  Write-Host "Setting new code period to reference branch '$ReferenceBranch'..."
  Invoke-SonarApi -Method "POST" -Path "/api/new_code_periods/set" -Body @{
    organization = $Organization
    project = $ProjectKey
    type = "REFERENCE_BRANCH"
    value = $ReferenceBranch
  } | Out-Null
} else {
  Write-Host "Skipping new code period API update (api/new_code_periods not available on this SonarCloud instance)."
}

Write-Host "Resolving quality gate for project..."
$gate = Invoke-SonarApi -Method "GET" -Path "/api/qualitygates/get_by_project" -Query @{
  organization = $Organization
  project = $ProjectKey
}
$gateId = $gate.qualityGate.id

$show = Invoke-SonarApi -Method "GET" -Path "/api/qualitygates/show" -Query @{
  organization = $Organization
  id = [string]$gateId
}

$desiredConditions = @(
  @{ metric = "new_reliability_rating"; op = "GT"; error = "1" },
  @{ metric = "new_security_rating"; op = "GT"; error = "1" },
  @{ metric = "new_maintainability_rating"; op = "GT"; error = "1" },
  @{ metric = "new_duplicated_lines_density"; op = "GT"; error = "3" },
  @{ metric = "new_security_hotspots_reviewed"; op = "LT"; error = "100" },
  @{ metric = "new_bugs"; op = "GT"; error = "0" },
  @{ metric = "new_vulnerabilities"; op = "GT"; error = "0" },
  @{ metric = "new_coverage"; op = "LT"; error = [string]$NewCoverageThreshold }
)
$projectGateAssigned = $true
if (-not $show.actions.manageConditions) {
  Write-Host "Current gate is not directly editable; preparing a project-specific gate..."
  $targetGateName = "imajin-ai hardening gate"
  $list = Invoke-SonarApi -Method "GET" -Path "/api/qualitygates/list" -Query @{ organization = $Organization }
  $targetGate = $list.qualitygates | Where-Object { $_.name -eq $targetGateName } | Select-Object -First 1

  if (-not $targetGate) {
    Write-Host "Copying current gate to '$targetGateName'..."
    Invoke-SonarApi -Method "POST" -Path "/api/qualitygates/copy" -Body @{
      organization = $Organization
      id = [string]$gateId
      name = $targetGateName
    } | Out-Null
    $list = Invoke-SonarApi -Method "GET" -Path "/api/qualitygates/list" -Query @{ organization = $Organization }
    $targetGate = $list.qualitygates | Where-Object { $_.name -eq $targetGateName } | Select-Object -First 1
  }

  if (-not $targetGate) {
    throw "Failed to resolve target quality gate '$targetGateName' after copy."
  }

  Write-Host "Assigning '$targetGateName' to project..."
  try {
    Invoke-SonarApi -Method "POST" -Path "/api/qualitygates/select" -Body @{
      organization = $Organization
      projectKey = $ProjectKey
      gateId = [string]$targetGate.id
    } | Out-Null
  } catch {
    $projectGateAssigned = $false
    Write-Host "Could not assign custom gate automatically (insufficient permission)."
  }

  $gateId = $targetGate.id
  $show = Invoke-SonarApi -Method "GET" -Path "/api/qualitygates/show" -Query @{
    organization = $Organization
    id = [string]$gateId
  }
}

$existing = @{}
foreach ($cond in $show.conditions) {
  if ($cond.metric) { $existing[$cond.metric] = $cond }
}

foreach ($desired in $desiredConditions) {
  $metric = $desired.metric
  if ($existing.ContainsKey($metric)) {
    Write-Host "Updating condition for $metric..."
    Invoke-SonarApi -Method "POST" -Path "/api/qualitygates/update_condition" -Body @{
      organization = $Organization
      id = [string]$existing[$metric].id
      metric = $desired.metric
      op = $desired.op
      error = $desired.error
    } | Out-Null
  } else {
    Write-Host "Creating condition for $metric..."
    Invoke-SonarApi -Method "POST" -Path "/api/qualitygates/create_condition" -Body @{
      organization = $Organization
      gateId = [string]$gateId
      metric = $desired.metric
      op = $desired.op
      error = $desired.error
    } | Out-Null
  }
}

Write-Host "Phase 1 policy lock-in applied successfully."
if (-not $projectGateAssigned) {
  Write-Host "Manual follow-up required: assign quality gate 'imajin-ai hardening gate' to project '$ProjectKey' in SonarCloud UI or with elevated token permissions."
}
