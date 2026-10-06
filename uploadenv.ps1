
# Bulk upload .env values to GitHub Actions secrets
# Run from your lead-forge repository folder

$ErrorActionPreference = "Stop"

$envFile = Join-Path (Get-Location) ".env"
if (!(Test-Path $envFile)) {
    throw ".env file not found in the current folder."
}

$remote = git remote get-url origin
if ($remote -notmatch 'github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$') {
    throw "Could not detect GitHub owner/repository from origin."
}
$owner = "Vikneshoftheleaf"
$repo = "Lead-forge"

Write-Host "Repository: $owner/$repo"

# Install Python encryption dependency if needed
python -m pip install pynacl
if ($LASTEXITCODE -ne 0) { throw "Could not install PyNaCl." }

$secureToken = Read-Host "Enter GitHub token" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)

    $headers = @{
        Authorization = "Bearer $token"
        Accept = "application/vnd.github+json"
        "X-GitHub-Api-Version" = "2022-11-28"
    }

    $base = "https://api.github.com/repos/$owner/$repo/actions/secrets"
    $key = Invoke-RestMethod "$base/public-key" -Headers $headers

    $count = 0
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*(#|$)') { continue }
        if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
            Write-Warning "Skipping invalid line."
            continue
        }

        $name = $Matches[1]
        $value = $Matches[2].Trim()

        # Remove matching outer quotes
        if ($value.Length -ge 2 -and
            (($value.StartsWith('"') -and $value.EndsWith('"')) -or
             ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        # Encrypt using GitHub's public key and libsodium sealed box
        $encrypted = $value | python -c "import sys,base64; from nacl.public import PublicKey,SealedBox; k=PublicKey(base64.b64decode('$($key.key)')); print(base64.b64encode(SealedBox(k).encrypt(sys.stdin.read().rstrip('\r\n').encode())).decode())"
        if ($LASTEXITCODE -ne 0 -or !$encrypted) {
            throw "Encryption failed for $name."
        }

        $body = @{
            encrypted_value = $encrypted.Trim()
            key_id = $key.key_id
        } | ConvertTo-Json

        Invoke-RestMethod -Method Put -Uri "$base/$name" `
            -Headers $headers -ContentType "application/json" -Body $body

        Write-Host "Uploaded: $name"
        $count++
    }

    Write-Host "Finished. Uploaded $count secrets."
}
finally {
    if ($ptr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
    $token = $null
}