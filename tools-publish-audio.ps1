param(
  [string]$Site = "C:\Users\29806\Documents\ChatGPT\雅思听力网页版",
  [int]$BatchSize = 10
)

$ErrorActionPreference = "Stop"

function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
  & git -C $Site @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git 命令失败：git $($Arguments -join ' ')"
  }
}

# 先补推本地已提交但尚未上传的批次，便于网络中断后继续。
Invoke-Git push origin main --progress

$tracked = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@(git -C $Site ls-files "*.mp3"),
  [System.StringComparer]::OrdinalIgnoreCase
)
$pending = @(
  Get-ChildItem -LiteralPath (Join-Path $Site "普通") -Recurse -File -Filter *.mp3 |
    Sort-Object FullName |
    Where-Object {
      $relative = [System.IO.Path]::GetRelativePath($Site, $_.FullName).Replace("\", "/")
      -not $tracked.Contains($relative)
    }
)

$batchNumber = 0
while ($pending.Count -gt 0) {
  $batchNumber += 1
  $batch = @($pending | Select-Object -First $BatchSize)
  $paths = @($batch | ForEach-Object {
    [System.IO.Path]::GetRelativePath($Site, $_.FullName).Replace("\", "/")
  })
  & git -C $Site add -f -- @paths
  if ($LASTEXITCODE -ne 0) { throw "添加音频批次失败" }
  Invoke-Git commit -m "Add listening audio batch $batchNumber"
  Invoke-Git push origin main --progress
  $pending = @($pending | Select-Object -Skip $batch.Count)
  Write-Host "已发布音频：$((git -C $Site ls-files '*.mp3' | Measure-Object).Count)/130"
}

if (Test-Path -LiteralPath (Join-Path $Site ".gitignore")) {
  Remove-Item -LiteralPath (Join-Path $Site ".gitignore")
  Invoke-Git add -u
  Invoke-Git commit -m "Track future listening audio updates"
  Invoke-Git push origin main --progress
}
