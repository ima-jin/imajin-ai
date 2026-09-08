# Shared helpers for parsing SonarCloud `/api/measures/component_tree`
# responses. Dot-sourced by scripts/sonar/phase1-capture-baseline.ps1 and
# scripts/sonar/phase15-legacy-debt-review.ps1 to avoid duplicating this
# logic across both scripts.

function Resolve-MeasureValue {
  param($Measure)
  $hasValue = $Measure.PSObject.Properties.Name -contains "value"
  if ($hasValue -and $Measure.value) { return [double]$Measure.value }
  $hasPeriods = $Measure.PSObject.Properties.Name -contains "periods"
  if ($hasPeriods -and $Measure.periods -and $Measure.periods.Count -gt 0) {
    return [double]$Measure.periods[0].value
  }
  return [double]0
}

function ConvertTo-MeasureMap {
  param($Measures)
  $m = @{}
  foreach ($measure in $Measures) {
    $m[$measure.metric] = Resolve-MeasureValue -Measure $measure
  }
  return $m
}

function Get-MetricOrZero {
  param([hashtable]$Map, [string]$Key)
  if ($Map.ContainsKey($Key)) { return $Map[$Key] }
  return 0
}
