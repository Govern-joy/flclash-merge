# 本地一键重建并推送（GitHub Actions 不可用时的替代方案）
#
# 用法：在本目录执行
#   pwsh -File .\rebuild.ps1
#
# 需要：Node 20+、git、已登录的 gh（gh auth status 能看到账号）
# 作用：拉取上游最新 FlClash-V61.js → 注入个人补丁 → 冒烟测试 → 提交并推 dist/
# 推送完成后，FlClash 里到脚本页点「同步」即可拿到新版。

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$repo = 'Govern-joy/flclash-merge'
$branch = 'main'

$env:RULES_BASE = "https://raw.githubusercontent.com/$repo/$branch/rules"

Write-Host '[rebuild] 构建中…' -ForegroundColor Cyan
node build.mjs
if ($LASTEXITCODE -ne 0) { throw '[rebuild] build.mjs 失败，已中止（dist 未提交）' }

Write-Host '[rebuild] 提交…' -ForegroundColor Cyan
git add -A
$staged = git diff --cached --name-only
if (-not $staged) {
  Write-Host '[rebuild] 没有变化，无需提交'
  exit 0
}
git -c user.name='Govern-joy' -c user.email='2025280410@mails.szu.edu.cn' commit -m 'chore: rebuild merged script'

Write-Host '[rebuild] 推送…' -ForegroundColor Cyan
$tok = (gh auth token).Trim()
$out = git push "https://x-access-token:$tok@github.com/$repo.git" "HEAD:$branch" 2>&1 | Out-String
$out.Replace($tok, '***') | Write-Host
if ($LASTEXITCODE -ne 0) { throw '[rebuild] 推送失败' }

Write-Host '[rebuild] 完成：FlClash → 脚本 → 同步' -ForegroundColor Green
