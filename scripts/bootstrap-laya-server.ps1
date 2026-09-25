$ErrorActionPreference = "Stop"

$RepoUrl = "https://github.com/nvkudva/laya-server.git"
$Commit = "0a2928f7ab415e8dd14bde483dc793e566c9f8fb"
$Model = if ($args.Count -gt 0) { $args[0] } else { "laya" }
$InstallDir = if ($env:DRAGON_LAYA_HOME) { $env:DRAGON_LAYA_HOME } else { Join-Path $HOME ".dragon\laya-server" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git is required"
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host "==> Installing uv"
  Invoke-RestMethod "https://astral.sh/uv/install.ps1" | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  throw "uv installation failed"
}

if (-not (Test-Path (Join-Path $InstallDir ".git"))) {
  Write-Host "==> Cloning laya-server into $InstallDir"
  git clone $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

Write-Host "==> Selecting pinned laya-server commit $Commit"
git -C $InstallDir fetch --depth 1 origin $Commit
if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
git -C $InstallDir checkout --detach $Commit
if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }

Write-Host "==> Installing laya-server command"
uv tool install --editable $InstallDir --quiet
if ($LASTEXITCODE -ne 0) { throw "laya-server installation failed" }
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"

Write-Host "==> Downloading Laya model: $Model"
laya-server pull $Model
if ($LASTEXITCODE -ne 0) { throw "Laya model download failed" }

Write-Host ""
Write-Host "Laya is installed. Dragon can now start it with the default command: laya-server"
Write-Host "Model cache: $env:HF_HOME"
