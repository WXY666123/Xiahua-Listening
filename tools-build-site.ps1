param(
  [string]$Source = "C:\Users\29806\Desktop\xiahua-listening-win\IELTS Listening 虾滑",
  [string]$Destination = "C:\Users\29806\Documents\ChatGPT\雅思听力网页版",
  [string]$Ffmpeg = "C:\Program Files (x86)\Labcenter Electronics\Proteus 8 Professional\BIN\ffmpeg.exe"
)

$ErrorActionPreference = "Stop"
$libraryDestination = Join-Path $Destination "普通"

if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
  throw "题库目录不存在：$Source"
}
if (-not (Test-Path -LiteralPath $Ffmpeg -PathType Leaf)) {
  throw "ffmpeg 不存在：$Ffmpeg"
}

New-Item -ItemType Directory -Force -Path $libraryDestination | Out-Null

Get-ChildItem -LiteralPath $Source -Recurse -File |
  Where-Object { $_.Extension -ne ".mp3" -and $_.Name -ne ".DS_Store" } |
  ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($Source, $_.FullName)
    $target = Join-Path $libraryDestination $relative
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
  }

$audioFiles = @(Get-ChildItem -LiteralPath $Source -Recurse -File -Filter *.mp3)
$audioFiles | ForEach-Object -Parallel {
  $file = $_
  $relative = [System.IO.Path]::GetRelativePath($using:Source, $file.FullName)
  $target = Join-Path $using:libraryDestination $relative
  if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -gt 0) {
    return
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  & $using:Ffmpeg -hide_banner -loglevel error -y -i $file.FullName -map_metadata -1 -vn -ac 1 -ar 44100 -b:a 48k $target
  if ($LASTEXITCODE -ne 0) {
    throw "音频转换失败：$($file.FullName)"
  }
} -ThrottleLimit 6

$items = [System.Collections.Generic.List[object]]::new()
Get-ChildItem -LiteralPath $Source -Recurse -File -Filter *.html |
  Sort-Object FullName |
  ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($Source, $_.FullName).Replace("\", "/")
    $html = [System.IO.File]::ReadAllText($_.FullName)
    $match = [regex]::Match($html, '<script[^>]*id=["'']test-data["''][^>]*>([\s\S]*?)</script>', "IgnoreCase")
    if (-not $match.Success) {
      throw "题目缺少 test-data：$($_.FullName)"
    }
    $testData = $match.Groups[1].Value | ConvertFrom-Json
    $lastWrite = [DateTimeOffset]$_.LastWriteTimeUtc
    $items.Add([ordered]@{
      path = "普通/$relative"
      size = $_.Length
      lastModified = $lastWrite.ToUnixTimeMilliseconds()
      signature = "web-v1"
      testData = $testData
    })
  }

$json = $items | ConvertTo-Json -Depth 100 -Compress
[System.IO.File]::WriteAllText(
  (Join-Path $Destination "JS\library-manifest.js"),
  "window.XIAHUA_LIBRARY_MANIFEST=$json;",
  [System.Text.UTF8Encoding]::new($false)
)

$readme = @"
# 虾滑雅思听力网页版

由桌面版转换的 iPad Safari 网页版。题库、音频、套题练习、计时、作答记录和解析均在浏览器中运行。

练习记录保存在当前浏览器。清除 Safari 网站数据会删除本机记录。
"@
[System.IO.File]::WriteAllText(
  (Join-Path $Destination "README.md"),
  $readme,
  [System.Text.UTF8Encoding]::new($false)
)

$manifestCount = $items.Count
$siteBytes = (Get-ChildItem -LiteralPath $Destination -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "完成：$manifestCount 篇题目，站点大小 $([math]::Round($siteBytes / 1MB, 1)) MB"
