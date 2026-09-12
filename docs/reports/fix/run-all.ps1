$node = '%USERPROFILE%\nodejs-x64\node-v22.21.0-win-x64\node.exe'
$out = '%USERPROFILE%\dsh-redact-fix\after'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$suites = @(
  @{ n = 'handler';  p = '%USERPROFILE%\dsh-plugin-redact\test\handler.selftest.mjs' },
  @{ n = 'bugfix';   p = '%USERPROFILE%\dsh-plugin-redact\test\bugfix-regression.mjs' },
  @{ n = 'hardening';p = '%USERPROFILE%\dsh-plugin-redact\test\hardening.mjs' },
  @{ n = 'surgery';  p = '%USERPROFILE%\session-surgery\selftest.mjs' }
)
foreach ($s in $suites) {
  & $node $s.p *> (Join-Path $out ($s.n + '.txt'))
  "$($s.n) exit=$LASTEXITCODE"
}

$repros = @('p1-refs','p2-undo','p3-hide','p4-write','p5-rollback','p6-scale','p7-purge','p8-structural')
foreach ($p in $repros) {
  & $node "%USERPROFILE%\dsh-redact-redteam\$p.mjs" *> (Join-Path $out ($p + '.txt'))
  "$p exit=$LASTEXITCODE"
}
Write-Output 'ALL DONE'
