#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies the Stellaris contracts are correctly built, correctly wired into
    the app, and free of the specific security footguns this project has
    already identified for itself. Run before every push.

.DESCRIPTION
    A check script, not a build script. PowerShell only orchestrates and parses
    output: all contract logic runs through `aiken` and the project's own Node
    scripts (TS/JS never gets pasted into PowerShell). Run from anywhere; every
    Node script is invoked from the repo root.

    Nine checks, covering all five Aiken projects:
      1. Git working tree clean (snapshot taken BEFORE anything runs)
      2. Aiken toolchain matches the pin in every aiken.toml
      3. aiken check - every project, all tests pass, zero warnings
      4. Blueprints - fresh `aiken build` equals the committed plutus.json,
         pinned hashes match (verify-vault-hash --strict), State datum
         encoder/decoder round-trip
      5. Live Preprod scripts match the local build (verify-live-scripts)
      6. Security rules present in source: fee/deposit caps, state-thread
         token on every shared-State validator (AUDIT.md F-1), position
         markers (F-4), output pinning (F-6, one shared outputs.ak),
         sUSDr frozen
      7. Mainnet refused: no tracked env file targets mainnet AND
         src/lib/network.ts hard-refuses it
      8. No secret/live keys in TRACKED env files
      9. fund_asset / set_fee governance kinds wired end to end

.PARAMETER RepoRoot
    Path to the stellaris-gateway checkout. Defaults to this script's parent
    directory's parent (the repo root).

.PARAMETER SkipLive
    Skip check 5 (Blockfrost). Use when BLOCKFROST_PREPROD_PROJECT_ID is unset.

.EXAMPLE
    .\scripts\verify-stellaris-contracts.ps1
    .\scripts\verify-stellaris-contracts.ps1 -SkipLive
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = '',
    [switch]$SkipLive
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is empty inside param() defaults on Windows PowerShell 5.1.
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$results = New-Object System.Collections.Generic.List[object]
$Projects = @('vault', 'fraction-vault', 'multi-asset-vault', 'susdr-vault', 'tessera')

function Add-Result {
    param(
        [string]$Check,
        [ValidateSet('PASS', 'WARN', 'FAIL')][string]$Status,
        [string]$Detail
    )
    $results.Add([pscustomobject]@{ Check = $Check; Status = $Status; Detail = $Detail })
}

function Write-Status {
    param([string]$Status, [string]$Message)
    $color = switch ($Status) { 'PASS' { 'Green' } 'WARN' { 'Yellow' } 'FAIL' { 'Red' } default { 'White' } }
    Write-Host "[$Status] " -ForegroundColor $color -NoNewline
    Write-Host $Message
}

# Run a native command with stdout/stderr captured to files. Windows PowerShell
# 5.1 wraps native stderr in ErrorRecords (and can throw under Stop), so never
# redirect it in-line.
function Invoke-Native {
    param([string]$File, [string[]]$Arguments, [string]$WorkingDirectory)
    $out = [System.IO.Path]::GetTempFileName()
    $err = [System.IO.Path]::GetTempFileName()
    try {
        $p = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
        [pscustomobject]@{
            ExitCode = $p.ExitCode
            StdOut   = [System.IO.File]::ReadAllText($out)
            StdErr   = [System.IO.File]::ReadAllText($err)
        }
    } finally {
        Remove-Item $out, $err -Force -ErrorAction SilentlyContinue
    }
}

function Get-LastLines {
    param([string]$Text, [int]$Count = 4)
    (($Text.Trim() -split "`r?`n") | Select-Object -Last $Count) -join ' | '
}

if (-not (Test-Path (Join-Path $RepoRoot 'contracts/vault'))) {
    Write-Host "Could not find contracts/vault under '$RepoRoot'. Pass -RepoRoot." -ForegroundColor Red
    exit 2
}
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
$aikenCmd = Get-Command aiken -ErrorAction SilentlyContinue

Write-Host "`n== Stellaris contract verification ==" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot`n"

# ---------------------------------------------------------------------------
# 1. Working tree clean - snapshot BEFORE the checks below run, so a pass is
#    known to describe committed code.
# ---------------------------------------------------------------------------
# Content-based fingerprint of the tree: `git diff` compares content, so a
# tool that rewrites a file byte-identically (aiken build with LF endings) does
# not count as a change, unlike `git status --porcelain`.
function Get-TreeFingerprint {
    $a = (Invoke-Native 'git' @('diff', '--name-only') $RepoRoot).StdOut
    $b = (Invoke-Native 'git' @('diff', '--cached', '--name-only') $RepoRoot).StdOut
    $c = (Invoke-Native 'git' @('ls-files', '--others', '--exclude-standard') $RepoRoot).StdOut
    "$a|$b|$c"
}

$statusBefore = ''
$fingerprintBefore = ''
if ($gitCmd) {
    $fingerprintBefore = Get-TreeFingerprint
    $statusBefore = (Invoke-Native 'git' @('status', '--porcelain') $RepoRoot).StdOut
    if ([string]::IsNullOrWhiteSpace($statusBefore)) {
        Add-Result '1. Git working tree clean' 'PASS' 'No uncommitted changes before verification'
    } else {
        $n = ($statusBefore -split "`r?`n" | Where-Object { $_.Trim() }).Count
        Add-Result '1. Git working tree clean' 'WARN' "$n uncommitted change(s) - the checks below verify the working tree, not a commit."
    }
} else {
    Add-Result '1. Git working tree clean' 'WARN' 'git not on PATH - skipped'
}

# ---------------------------------------------------------------------------
# 2. Toolchain matches every project's pin
# ---------------------------------------------------------------------------
$pins = @{}
foreach ($p in $Projects) {
    $toml = Join-Path $RepoRoot "contracts/$p/aiken.toml"
    $m = Select-String -Path $toml -Pattern 'compiler\s*=\s*"v?([\d.]+)"' | Select-Object -First 1
    $pins[$p] = if ($m) { $m.Matches[0].Groups[1].Value } else { '?' }
}
$distinctPins = @($pins.Values | Sort-Object -Unique)
if (-not $aikenCmd) {
    Add-Result '2. Aiken toolchain' 'FAIL' 'aiken not on PATH'
} else {
    $verOut = (Invoke-Native 'aiken' @('--version') $RepoRoot).StdOut
    $installed = ([regex]::Match($verOut, '(\d+\.\d+\.\d+)')).Groups[1].Value
    if ($distinctPins.Count -ne 1) {
        Add-Result '2. Aiken toolchain' 'FAIL' ("Projects pin different compilers: " + (($pins.GetEnumerator() | ForEach-Object { "$($_.Key)=v$($_.Value)" }) -join ', '))
    } elseif ($installed -ne $distinctPins[0]) {
        Add-Result '2. Aiken toolchain' 'WARN' "Installed v$installed, projects pin v$($distinctPins[0])"
    } else {
        Add-Result '2. Aiken toolchain' 'PASS' "v$installed, matches all $($Projects.Count) aiken.toml pins"
    }
}

# ---------------------------------------------------------------------------
# 3. aiken check - every project. Non-TTY output is JSON (aiken check --help).
# ---------------------------------------------------------------------------
if ($aikenCmd) {
    $summary = @(); $problems = @()
    foreach ($p in $Projects) {
        $r = Invoke-Native 'aiken' @('check') (Join-Path $RepoRoot "contracts/$p")
        $warnings = ([regex]::Matches($r.StdErr, '(?i)\bwarning\b')).Count
        try {
            $j = $r.StdOut | ConvertFrom-Json
            $summary += "$p $($j.summary.passed)/$($j.summary.total)"
            if ($j.summary.failed -gt 0) {
                $failed = @($j.modules | ForEach-Object { $mod = $_.name; $_.tests | Where-Object { $_.status -ne 'pass' } | ForEach-Object { "$mod.$($_.title)" } })
                $problems += "$p failing: $($failed -join ', ')"
            }
        } catch {
            $problems += "$p did not compile (exit $($r.ExitCode)) - run 'aiken check' in contracts/$p in a terminal to see the error"
        }
        if ($warnings -gt 0) { $problems += "$p has $warnings compiler warning(s)" }
    }
    if ($problems.Count) { Add-Result '3. aiken check (all projects)' 'FAIL' ($problems -join '; ') }
    else { Add-Result '3. aiken check (all projects)' 'PASS' (($summary -join ', ') + ', 0 warnings') }
} else {
    Add-Result '3. aiken check (all projects)' 'FAIL' 'Skipped - aiken not installed'
}

# ---------------------------------------------------------------------------
# 4. Blueprints: fresh build == committed, pins match, datum round-trip
# ---------------------------------------------------------------------------
$bp = @()
if ($aikenCmd -and $gitCmd) {
    foreach ($p in $Projects) {
        $b = Invoke-Native 'aiken' @('build') (Join-Path $RepoRoot "contracts/$p")
        if ($b.ExitCode -ne 0) { $bp += "$p 'aiken build' failed"; continue }
        $d = Invoke-Native 'git' @('diff', '--quiet', '--', "contracts/$p/plutus.json") $RepoRoot
        if ($d.ExitCode -ne 0) { $bp += "contracts/$p/plutus.json is stale (rebuilt now - review and commit it)" }
    }
} else { $bp += 'aiken or git missing - fresh-build comparison skipped' }
if ($nodeCmd) {
    $h = Invoke-Native 'node' @('scripts/verify-vault-hash.mjs', '--strict') $RepoRoot
    if ($h.ExitCode -ne 0) { $bp += "drift guard: $(Get-LastLines ($h.StdOut + $h.StdErr))" }
    $rt = Invoke-Native 'npx.cmd' @('tsx', 'scripts/verify-state-datum-roundtrip.ts') $RepoRoot
    if ($rt.ExitCode -ne 0) { $bp += "datum round-trip: $(Get-LastLines ($rt.StdOut + $rt.StdErr))" }
} else { $bp += 'node not on PATH - drift guard and round-trip skipped' }
if ($bp.Count) { Add-Result '4. Blueprints (fresh build, pins, datum round-trip)' 'FAIL' ($bp -join '; ') }
else { Add-Result '4. Blueprints (fresh build, pins, datum round-trip)' 'PASS' "All $($Projects.Count) plutus.json match a fresh build; every pinned hash matches; State datum round-trips" }

# ---------------------------------------------------------------------------
# 5. Live Preprod scripts. verify-live-scripts.mjs exits 1 on MISMATCH, 2 on
#    setup errors, 0 otherwise.
# ---------------------------------------------------------------------------
if ($SkipLive) {
    Add-Result '5. Live Preprod scripts match local build' 'WARN' 'Skipped by -SkipLive'
} elseif (-not $env:BLOCKFROST_PREPROD_PROJECT_ID) {
    Add-Result '5. Live Preprod scripts match local build' 'WARN' 'BLOCKFROST_PREPROD_PROJECT_ID not set in this shell - skipped'
} elseif (-not $nodeCmd) {
    Add-Result '5. Live Preprod scripts match local build' 'FAIL' 'node not on PATH'
} else {
    $l = Invoke-Native 'node' @('scripts/verify-live-scripts.mjs') $RepoRoot
    switch ($l.ExitCode) {
        0 {
            if ($l.StdOut -match 'not seen on-chain') {
                Add-Result '5. Live Preprod scripts match local build' 'PASS' 'No mismatches; some derived scripts have not been used on-chain yet (expected before bootstrap)'
            } else {
                Add-Result '5. Live Preprod scripts match local build' 'PASS' 'Every script seen on-chain matches the local build'
            }
        }
        1 { Add-Result '5. Live Preprod scripts match local build' 'FAIL' ("MISMATCH: " + (($l.StdOut -split "`r?`n" | Select-String 'MISMATCH|^vault/|^yield_vault/') -join ' | ')) }
        default { Add-Result '5. Live Preprod scripts match local build' 'FAIL' (Get-LastLines ($l.StdErr + $l.StdOut)) }
    }
}

# ---------------------------------------------------------------------------
# 6. Security rules present in source (catches an accidental edit that the
#    tests might not, e.g. a loosened cap with a loosened test).
# ---------------------------------------------------------------------------
$rules = @(
    @{ File = 'contracts/vault/lib/stellaris/shares.ak'; Pattern = 'max_fee_bps: Int = 500'; Label = 'vault fee cap 5%/yr' }
    @{ File = 'contracts/vault/lib/stellaris/shares.ak'; Pattern = 'min_initial_deposit: Int = 10_000_000'; Label = 'vault 10 ADA bootstrap floor' }
    @{ File = 'contracts/vault/lib/stellaris/shares.ak'; Pattern = 'min_position_value: Int = 2_000_000'; Label = 'vault 2 ADA position floor' }
    @{ File = 'contracts/multi-asset-vault/lib/stellaris/shares.ak'; Pattern = 'min_initial_deposit: Int = 10_000_000'; Label = 'multi-asset bootstrap floor' }
    @{ File = 'contracts/fraction-vault/lib/stellaris/offering.ak'; Pattern = 'max_fee_bps: Int = 500'; Label = 'offering fee cap 5%' }
    @{ File = 'contracts/vault/validators/yield_vault.ak'; Pattern = 'one_shot_mint(tx, policy_id, seed)'; Label = 'yield_vault state-thread mint (F-1)' }
    @{ File = 'contracts/vault/validators/yield_vault.ak'; Pattern = 'holds_thread(own_in.output.value, hash)'; Label = 'yield_vault spends only the genuine State (F-1)' }
    @{ File = 'contracts/vault/validators/yield_vault.ak'; Pattern = 'expect Some(_only_state_in) = sole_state(ins)'; Label = 'yield_vault sole State input (V-01)' }
    @{ File = 'contracts/vault/validators/yield_vault.ak'; Pattern = 'genuine && markers_conserved'; Label = 'yield_vault position markers conserved (F-4)' }
    @{ File = 'contracts/vault/validators/yield_vault.ak'; Pattern = 'marked && owner_signed'; Label = 'yield_vault spends only marked Positions (F-4)' }
    @{ File = 'contracts/vault/validators/receipt.ak'; Pattern = 'use stellaris/yield_datum.{State, YieldDatum}'; Label = 'receipt shares the vault datum type (F-2)' }
    @{ File = 'contracts/multi-asset-vault/validators/multi_asset_vault.ak'; Pattern = 'one_shot_mint(tx, policy_id, seed)'; Label = 'multi_asset_vault state-thread mint (F-1)' }
    @{ File = 'contracts/multi-asset-vault/validators/multi_asset_vault.ak'; Pattern = 'genuine && markers_conserved'; Label = 'multi_asset_vault position markers conserved (F-4)' }
    @{ File = 'contracts/multi-asset-vault/validators/multi_asset_vault.ak'; Pattern = 'marked && owner_signed'; Label = 'multi_asset_vault spends only marked Positions (F-4)' }
    @{ File = 'contracts/fraction-vault/validators/fraction_vault.ak'; Pattern = 'one_shot_mint(tx, policy_id, seed)'; Label = 'fraction_vault state-thread mint (F-1)' }
    @{ File = 'contracts/susdr-vault/README.md'; Pattern = 'DO NOT BOOTSTRAP'; Label = 'susdr_vault frozen notice (F-1)' }
    @{ File = 'contracts/tessera/lib/tessera/rules.ak'; Pattern = 'qty > 0 && minted_supply + qty <= attested_reserve && minted_supply + qty <= mint_cap'; Label = 'tessera mint within reserve and cap' }
    @{ File = 'contracts/tessera/lib/tessera/rules.ak'; Pattern = 'max_attestation_age: Int = 604_800_000'; Label = 'tessera 7-day attestation freshness' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'expect Some((state_in, in_state)) = sole_state(ins, own_hash)'; Label = 'tessera sole token-bearing State input' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'assets.without_lovelace(out.value) == thread_value(policy)'; Label = 'tessera State holds exactly ADA + thread token' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'genesis_ok(s, lo, hi)'; Label = 'tessera genesis datum checked on-chain (2.2)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'threshold_met(operators, threshold, tx.extra_signatories)'; Label = 'tessera rotation needs the new committee too (2.2)' }
    @{ File = 'contracts/tessera/lib/tessera/rules.ak'; Pattern = 'min_threshold: Int = 2'; Label = 'tessera committee threshold >= 2' }
    @{ File = 'contracts/tessera/lib/tessera/rules.ak'; Pattern = 'max_mint_cap: Int = 1_000_000_000_000_000'; Label = 'tessera mint cap hard max 1B TSRA' }
    @{ File = 'contracts/tessera/lib/tessera/eligibility.ak'; Pattern = 'list.has(tx.extra_signatories, holder) && ('; Label = 'tessera eligible() needs the holder signature (2.3)' }
    @{ File = 'contracts/tessera/lib/tessera/eligibility.ak'; Pattern = 'quantity_of(i.output.value, policy, holder) == 1'; Label = 'tessera eligible() needs exactly the holder token (2.3)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'kyc_ok(s0.kyc_mint, tx, s0.eligibility_policy, holder)'; Label = 'tessera Mint gated by kyc_mint (2.3)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'kyc_ok(s0.kyc_redeem, tx, s0.eligibility_policy, holder)'; Label = 'tessera Burn gated by kyc_redeem (2.3)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'bytearray.length(eligibility_policy) == 28'; Label = 'tessera SetKyc policy must be a policy id (2.3)' }
    @{ File = 'contracts/tessera/validators/eligibility.ak'; Pattern = 'committee_signed(tx, reserve),'; Label = 'tessera eligibility issue/revoke needs the reserve committee (2.3)' }
    @{ File = 'contracts/tessera/validators/eligibility.ak'; Pattern = 'tokens_stay_in_registry(tx, policy_id)'; Label = 'tessera eligibility tokens stay in the registry (2.3)' }
    @{ File = 'contracts/tessera/validators/eligibility.ak'; Pattern = 'quantity_of(tx.mint, policy, name) <= -q'; Label = 'tessera eligibility tokens leave the registry only by burning (2.3)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'genesis_ok(s, policy)'; Label = 'tessera sTSRA vault genesis checked on-chain (2.4)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'tsra(reserve, s.short_assets + s.long_assets + s.vest_short + s.vest_long),'; Label = 'tessera sTSRA vault State holds exactly its accounted TSRA, vesting included (2.4, 2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'lo >= t.claim_after'; Label = 'tessera sTSRA cooldown enforced at Claim (2.4)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'claim_after: hi + s0.short_cooldown_ms'; Label = 'tessera sTSRA Ticket cooldown set from the upper bound (2.4)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'lo >= p.unlock_at'; Label = 'tessera sTSRA long lock enforced at unlock (2.4)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'ins == [own],'; Label = 'tessera sTSRA one Ticket per Claim, no double satisfaction (2.4)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'paid_tsra(tx, s0.first_loss_addr, reserve) >= to_first_loss'; Label = 'tessera sTSRA yield pays the first-loss share (2.4)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'committee_ok(tx, reserve),'; Label = 'tessera sTSRA committee from the live Reserve State (2.4)' }
    @{ File = 'contracts/tessera/lib/tessera/vault_state.ak'; Pattern = 'max_long_weight_bps: Int = 15_000'; Label = 'tessera sTSRA long weight hard max 1.5x (2.4)' }
    @{ File = 'contracts/tessera/lib/tessera/vault_state.ak'; Pattern = 'max_long_lock_ms: Int = 7_776_000_000'; Label = 'tessera sTSRA long lock hard max 90 days (2.4)' }
    @{ File = 'contracts/tessera/lib/tessera/vault_state.ak'; Pattern = 'max_short_cooldown_ms: Int = 1_209_600_000'; Label = 'tessera sTSRA short cooldown hard max 14 days (2.4)' }
    @{ File = 'contracts/tessera/lib/tessera/exchange.ak'; Pattern = 'max_yield_fee_bps: Int = 2000'; Label = 'tessera sTSRA protocol share hard max 20% (2.4)' }
    @{ File = 'contracts/tessera/lib/stellaris/outputs.ak'; Pattern = 'out.address == spent.address,'; Label = 'tessera F-6 continuing outputs keep the exact address (2-H)' }
    @{ File = 'contracts/tessera/lib/stellaris/outputs.ak'; Pattern = 'out.reference_script == None,'; Label = 'tessera F-6 script outputs carry no reference script (2-H)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'continuing_ok(next_out, state_in),'; Label = 'tessera F-6 reserve State pinned (2-H)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'keeps_lovelace(next_out, state_in),'; Label = 'tessera F-6 reserve State keeps its lovelace (2-H)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = 'genesis_out_ok(boot, policy),'; Label = 'tessera F-6 reserve genesis at the enterprise address (2-H)' }
    @{ File = 'contracts/tessera/validators/eligibility.ak'; Pattern = 'genesis_out_ok(o, policy)'; Label = 'tessera F-6 eligibility registry outputs pinned (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'continuing_ok(next_out, state_in),'; Label = 'tessera F-6 sTSRA State pinned (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'keeps_lovelace(next_out, state_in),'; Label = 'tessera F-6 sTSRA State keeps its lovelace (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'continuing_ok(pos, state_in),'; Label = 'tessera F-6 sTSRA new Position at the State address (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'continuing_ok(ticket, state_in),'; Label = 'tessera F-6 sTSRA new Ticket at the State address (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'genesis_out_ok(boot, policy),'; Label = 'tessera F-6 sTSRA genesis at the enterprise address (2-H)' }
    @{ File = 'contracts/vault/validators/yield_vault.ak'; Pattern = 'list.all(outs, fn(o) { continuing_ok(o, own_in.output) })'; Label = 'tessera F-6 yield_vault outputs pinned (2-H)' }
    @{ File = 'contracts/vault/validators/yield_vault.ak'; Pattern = 'genesis_out_ok(boot, policy_id)'; Label = 'tessera F-6 yield_vault bootstrap at the enterprise address (2-H)' }
    @{ File = 'contracts/multi-asset-vault/validators/multi_asset_vault.ak'; Pattern = 'list.all(outs, fn(o) { continuing_ok(o, own_in.output) })'; Label = 'tessera F-6 multi_asset_vault outputs pinned (2-H)' }
    @{ File = 'contracts/multi-asset-vault/validators/multi_asset_vault.ak'; Pattern = 'is_ada(unit_policy) || keeps_lovelace(next_out, own_in.output)'; Label = 'tessera F-6 multi_asset_vault lovelace exception only for an ADA unit (2-H)' }
    @{ File = 'contracts/fraction-vault/validators/fraction_vault.ak'; Pattern = 'continuing_ok(state_out, only_in)'; Label = 'tessera F-6 fraction_vault offering pinned (2-H)' }
    @{ File = 'contracts/fraction-vault/validators/fraction_vault.ak'; Pattern = 'pays_ada_out || keeps_lovelace(state_out, only_in)'; Label = 'tessera F-6 fraction_vault lovelace exception only for an ADA unit (2-H)' }
    @{ File = 'contracts/tessera/lib/tessera/vault_state.ak'; Pattern = 'pub const vest_period_ms: Int = 604_800_000'; Label = 'tessera sTSRA yield vests over a hard-coded 7 days (2-H)' }
    @{ File = 'contracts/tessera/lib/tessera/vault_state.ak'; Pattern = 'long_lock_ms >= 2 * short_cooldown_ms,'; Label = 'tessera sTSRA long lock at least twice the cooldown (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'let sf = fold(s0, lo)'; Label = 'tessera sTSRA vesting booked at the validity lower bound only (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'let price_assets = short_assets_at(sf, hi)'; Label = 'tessera sTSRA stakes priced at the upper bound (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'hi - lo <= rules.max_attest_window,'; Label = 'tessera sTSRA ReportYield window at most 1 day (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'owner_authorised(tx, p.owner),'; Label = 'tessera sTSRA UnlockLong needs its owner (2-H)' }
    @{ File = 'contracts/tessera/validators/stsra_vault.ak'; Pattern = 'lovelace_of(paid) >= lovelace_of(spent.value),'; Label = 'tessera sTSRA exits return the spent UTxOs ADA (2-H)' }
    @{ File = 'contracts/tessera/validators/reserve.ak'; Pattern = '!s0.paused,'; Label = 'tessera mint blocked while paused' }
)
$missingRules = @()
foreach ($r in $rules) {
    $path = Join-Path $RepoRoot $r.File
    if (-not (Test-Path $path) -or -not ((Get-Content $path -Raw -Encoding UTF8).Contains($r.Pattern))) {
        $missingRules += "$($r.Label) [$($r.File)]"
    }
}
$outputsCopies = @('contracts/vault', 'contracts/multi-asset-vault', 'contracts/fraction-vault', 'contracts/tessera') | ForEach-Object { Join-Path $RepoRoot "$_/lib/stellaris/outputs.ak" }
$outputsHashes = @($outputsCopies | ForEach-Object { if (Test-Path $_) { (Get-FileHash $_ -Algorithm SHA256).Hash } else { 'missing' } } | Select-Object -Unique)
if ($outputsHashes.Count -ne 1 -or $outputsHashes[0] -eq 'missing') {
    $missingRules += 'F-6 lib/stellaris/outputs.ak must exist and be byte-identical in all four projects'
}
if ($missingRules.Count) { Add-Result '6. Security rules present in source' 'FAIL' ("Changed or missing: " + ($missingRules -join '; ')) }
else { Add-Result '6. Security rules present in source' 'PASS' "$($rules.Count) caps/guards intact, incl. state-thread token on all 3 shared-State validators and position markers on both Position vaults" }

# ---------------------------------------------------------------------------
# 7. Mainnet refused - in tracked env files AND in code
# ---------------------------------------------------------------------------
$trackedEnv = @()
if ($gitCmd) {
    $trackedEnv = @((Invoke-Native 'git' @('ls-files', '.env*') $RepoRoot).StdOut -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '\.example$' })
}
$mainnetHits = @()
foreach ($f in $trackedEnv) {
    $hits = Select-String -Path (Join-Path $RepoRoot $f) -Pattern 'VITE_BLOCKFROST_NETWORK\s*=\s*"?mainnet"?' -ErrorAction SilentlyContinue
    if ($hits) { $mainnetHits += $f }
}
$net = Get-Content (Join-Path $RepoRoot 'src/lib/network.ts') -Raw
$guard = $net.Contains('export const MAINNET_NOT_ALLOWED = true;') -and ($net -match 'requestedNetwork\(\) === "mainnet" && !MAINNET_NOT_ALLOWED')
if ($mainnetHits.Count) {
    Add-Result '7. Mainnet refused (env + code)' 'FAIL' ("Tracked env file targets mainnet: " + ($mainnetHits -join ', '))
} elseif (-not $guard) {
    Add-Result '7. Mainnet refused (env + code)' 'FAIL' 'src/lib/network.ts no longer hard-refuses mainnet (MAINNET_NOT_ALLOWED guard changed)'
} else {
    Add-Result '7. Mainnet refused (env + code)' 'PASS' "$($trackedEnv.Count) tracked env file(s) on preprod; network.ts never resolves to mainnet"
}

# ---------------------------------------------------------------------------
# 8. Secrets in TRACKED env files (publishable/anon/test keys are expected)
# ---------------------------------------------------------------------------
$secretPatterns = @(
    @{ Pattern = 'sk_(live|test)_[A-Za-z0-9]+'; Label = 'Stripe secret key'; Level = 'FAIL' }
    @{ Pattern = 'rk_(live|test)_[A-Za-z0-9]+'; Label = 'Stripe restricted key'; Level = 'FAIL' }
    @{ Pattern = 'sb_secret_[A-Za-z0-9_-]+'; Label = 'Supabase secret key'; Level = 'FAIL' }
    @{ Pattern = 'service_role'; Label = 'Supabase service_role reference'; Level = 'FAIL' }
    @{ Pattern = 'mainnet[A-Za-z0-9]{32}'; Label = 'Blockfrost MAINNET project id'; Level = 'FAIL' }
    @{ Pattern = 'preprod[A-Za-z0-9]{32}'; Label = 'Blockfrost preprod project id (keep it in your shell, not git)'; Level = 'WARN' }
)
$secretFail = @(); $secretWarn = @()
foreach ($f in $trackedEnv) {
    $text = Get-Content (Join-Path $RepoRoot $f) -Raw
    foreach ($s in $secretPatterns) {
        if ($text -match $s.Pattern) {
            if ($s.Level -eq 'FAIL') { $secretFail += "${f}: $($s.Label)" } else { $secretWarn += "${f}: $($s.Label)" }
        }
    }
}
if ($secretFail.Count) { Add-Result '8. No secrets in tracked env files' 'FAIL' ($secretFail -join ' | ') }
elseif ($secretWarn.Count) { Add-Result '8. No secrets in tracked env files' 'WARN' ($secretWarn -join ' | ') }
else { Add-Result '8. No secrets in tracked env files' 'PASS' 'Only publishable/anon keys in tracked env files' }

# ---------------------------------------------------------------------------
# 9. fund_asset / set_fee wired: allowlist AND execution handler
# ---------------------------------------------------------------------------
$shared = Get-Content (Join-Path $RepoRoot 'src/lib/governance-vault.shared.ts') -Raw
$fns = Get-Content (Join-Path $RepoRoot 'src/lib/governance-vault.functions.ts') -Raw
$kinds = @('fund_asset', 'set_fee')
$gaps = @()
foreach ($k in $kinds) {
    if ($shared -notmatch "[`"']$k[`"']") { $gaps += "$k missing from PROPOSAL_KINDS" }
    if ($fns -notmatch "row\.kind === [`"']$k[`"']") { $gaps += "$k has no recordProposalExecution branch" }
}
if ($gaps.Count) { Add-Result '9. Governance kinds wired' 'WARN' ($gaps -join '; ') }
else { Add-Result '9. Governance kinds wired' 'PASS' 'fund_asset and set_fee: in PROPOSAL_KINDS and handled by recordProposalExecution' }

# ---------------------------------------------------------------------------
# Did the checks themselves change anything (e.g. a stale plutus.json rebuilt)?
# ---------------------------------------------------------------------------
if ($gitCmd) {
    if ((Get-TreeFingerprint) -ne $fingerprintBefore) {
        Add-Result '1. Git working tree clean' 'FAIL' 'Verification itself modified files (see git status) - review and commit, then re-run.'
    }
}

Write-Host ""
foreach ($r in $results) { Write-Status $r.Status "$($r.Check) - $($r.Detail)" }

$failCount = @($results | Where-Object Status -eq 'FAIL').Count
$warnCount = @($results | Where-Object Status -eq 'WARN').Count
$passCount = @($results | Where-Object Status -eq 'PASS').Count
Write-Host "`n== Summary: $passCount passed, $warnCount warnings, $failCount failed ==" -ForegroundColor Cyan

if ($failCount -gt 0) {
    Write-Host 'NOT verified - resolve the FAIL item(s) above before pushing.' -ForegroundColor Red
    exit 1
} elseif ($warnCount -gt 0) {
    Write-Host 'Passing, with warnings worth reading before you rely on this.' -ForegroundColor Yellow
    exit 0
} else {
    Write-Host 'All checks passed cleanly.' -ForegroundColor Green
    exit 0
}
