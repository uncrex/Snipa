# Snipa

A non-custodial TypeScript CLI that monitors new Pump.fun tokens and can submit
bounded, locally signed trades. It does not front-run, sandwich, reorder, or
interfere with other users' transactions.

The target production architecture and current gaps are tracked in
[`docs/ROADMAP.md`](docs/ROADMAP.md).

## Safety model

- Paper mode is the default. It prints orders without constructing or sending a transaction.
- Live trading requires `LIVE_TRADING=true`.
- Automatic buying additionally requires `AUTO_BUY=true`.
- Buy size, cumulative session spend, wallet reserve, slippage, priority fee,
  and buys per session have validated bounds.
- Automatic mode buys a given mint at most once per monitor session.
- Private keys remain local. PumpPortal receives only the public key and returns an unsigned transaction.
- Before signing, the wallet must be the sole signer and fee payer, all address
    lookup tables must resolve, every top-level program must be allowlisted, and
    each Pump or PumpSwap instruction must match the requested action, mint,
    official account layout, signer/writable roles, wrapped-SOL quote mint, and
    slippage-adjusted aggregate buy-spend limit.
- Authorized PumpSwap instructions expose their exact pool, ordered mints, and
    base/quote pool-vault addresses from the version-pinned official account
    ordering. Aliased pool, mint, or vault identities are rejected. Live
    simulation requests those exact vault accounts, decodes only initialized
    classic SPL Token account returns with matching mints, journals post-simulation
    raw balances, and fails closed when a requested return is missing or malformed.
- Compute-unit settings are decoded and capped by `PRIORITY_FEE_SOL`. Only
    deterministic ATA creation for the configured wallet and trade/WSOL mint is
    accepted; top-level System and SPL Token instructions fail closed.
- Live execution requires an exact-content arm file that is checked before the
    live path, before signing, and immediately before broadcast.
- Every live transaction is signed locally, simulated before broadcast, and
    checked for on-chain execution errors before being reported as confirmed.
- Every live trade has a wall-clock intent expiry. The original candidate time is
    checked before requesting a route, before signing, and immediately before
    broadcast so slow RPC, policy, audit, or simulation work cannot submit a stale
    intent.
- Before requesting a live sell route, authoritative account bytes must decode as
    classic 165-byte SPL Token accounts owned by the classic token program, match
    the requested mint and wallet owner, and contain sufficient initialized,
    non-frozen raw balance. Percentage sells require a nonzero spendable balance;
    explicit token amounts decode decimals from the classic 82-byte mint without
    applying buy-only authority restrictions. The derived raw sell cap is journaled
    and enforced against decoded Pump/PumpSwap instruction amounts; every sell
    instruction must also encode a nonzero minimum quote output.

Use a dedicated wallet with only the amount you are prepared to lose. New-token
markets are extremely risky, and filters do not establish that a token is safe.

## Setup

Requires Node.js 20 or newer.

```powershell
npm.cmd install
Copy-Item .env.example .env
```

Edit `.env` and set `SOLANA_KEYPAIR_PATH` to a Solana CLI keypair JSON file.
`SOLANA_PRIVATE_KEY` also accepts a base58 secret or JSON byte array, but a file
path avoids placing the key directly in environment configuration. When both are
configured, a nonblank `SOLANA_PRIVATE_KEY` takes precedence. Enter secrets only
in the local `.env` file; never paste a private key into chat or the dashboard.

Check the connected address and balance:

```powershell
npm.cmd run wallet
```

## Monitor and paper trade

Monitor all new token creation events:

```powershell
npm.cmd run monitor
```

PumpPortal messages pass through the pinned `pumpportal-launch-v1` decoder before
filtering. It requires a valid mint, a 64-byte transaction signature, and
`txType: "create"`; canonical transaction identities are deduplicated across
WebSocket reconnects. Because PumpPortal does not provide a bounded backfill, any
disconnect after the initial connection permanently compromises stream continuity
for that monitor process. Detection continues after reconnect, but automatic entry
fails closed with an exact skip reason until the monitor is restarted. Versioned
stream-health events expose connected, disconnected, and compromised state to the
dashboard without participating in transaction construction.

The Phase 2 reserve-state contract uses raw integer amounts and requires venue,
pool, mint pair, decoder version, source, slot, write version, and observation
time. Consumers supply explicit age and slot-skew limits; regressive updates and
inconsistent snapshot sets fail closed. Live reserve ingestion remains disabled
until venue-specific decoders are available. The currently tested snapshot
contracts pin Pump to `pump-reserves-v1` and PumpSwap to
`pumpswap-reserves-v1`; unknown versions, cross-venue version labels, and all
unimplemented Raydium or Meteora decoder claims are rejected before storage.
Snapshot storage is bounded and keyed by source, venue, and pool. Cross-provider
state is exposed only after decoder identity, pool identity, freshness, slot
skew, and integer basis-point reserve divergence all agree within caller limits.
For validated `pumpswap-reserves-v1` snapshots, the local quote foundation can
calculate exact-input constant-product output, fee amount, and ceiling-rounded
price impact in either direction using raw integer arithmetic. Every quote also
requires an explicit maximum price impact and rejects values above that inclusive
ceiling. Quote records pin the model and reserve decoder versions, source event,
pool, mints, slot/write version, fee and impact inputs, modeled post-trade
reserves, and before/after invariant for deterministic replay. The fee rate and
impact ceiling are caller inputs. An atomic candidate-quote admission contract
requires fresh snapshots, an exact pool and ordered mint pair, an explicit quote
source, and the impact ceiling; multi-provider inputs additionally require an
explicit convergence limit before the selected source can be quoted. A separate
validator compares simulated
effective input, output, and both post-trade reserves against the quote with
exact pool, ordered-mint, and trade-direction identity plus explicit slot-skew
and ceiling basis-point tolerances. A composed pre-execution contract returns the
quote and simulation agreement only after reserve admission succeeds first, so a
caller cannot omit or reorder those checks. Live simulation now collects and
validates policy-bound PumpSwap post-trade vault balances. After transaction
authorization and before signing, execution also takes one same-slot confirmed RPC
point read of those exact vaults, decodes their classic SPL Token state, and
durably journals a pinned pre-trade snapshot without recording the RPC URL.
Authorization now exposes and durably journals each PumpSwap instruction's exact
input/output semantics and both raw amount constraints, including exact-output
buys, exact-quote-input buys, and exact-base-input sells. Continuous or
multi-provider reserve ingestion is still missing. Authorization pins the official
PumpSwap global-config, fee-config, and fee-program identities. The same confirmed
RPC batch now decodes and journals the fee program's flat, market-cap-tiered, and
stable-tier schedules with the reserves at one slot. Dynamic tier selection still
needs authoritative market-cap and stable-quote inputs, and the quote model must
apply LP, protocol, and creator fees with instruction-specific rounding before
runtime gating is enabled. Executable routing and runtime candidate gating remain
unimplemented.

Set `TOKEN_NAME_REGEX` and/or `TOKEN_SYMBOL_REGEX` to filter matches. To exercise
the automatic order path without spending SOL, leave `LIVE_TRADING=false` and set:

```dotenv
AUTO_BUY=true
BUY_AMOUNT_SOL=0.01
MAX_BUYS_PER_SESSION=1
MAX_SESSION_BUY_SOL=0.05
MIN_SOL_RESERVE=0.02
```

You can also submit an explicit paper order:

```powershell
npm.cmd run trade -- buy TOKEN_MINT 0.01
npm.cmd run trade -- sell TOKEN_MINT 100%
```

## Telegram community bots

The repository includes separate least-privilege services for
`@WetzelSOLModBot` and `@WetzelSOLBot`. The moderator provides `/rules`, `/links`,
`/about`, `/buy`, `/chart`, `/faq`, metadata-only `/report`, admin-only `/chatid`,
`/raid`, `/pinwelcome`, `/invite`, `/campaigns`, and `/poll`, welcomes,
10-minute new-member media restrictions,
forwarded-promotion deletion, flood throttling, and a metadata-only local incident
log. The alert bot is outbound-only: it reads the append-only trade journal and
polls confirmed Solana transactions for the configured mint. Public alerts require
a successful recognized Pump or PumpSwap buy instruction, the exact configured
mint and buyer, a positive buyer token-balance delta, and a buyer wallet SOL
decrease at or above `TELEGRAM_BUY_ALERT_MIN_SOL`. A bounded
`TELEGRAM_PUBLIC_BUY_LOOKBACK_SECONDS` backfill recovers recent buys after a
restart, and delivered transaction signatures are durably deduplicated together
with their Telegram chat and message IDs for exact later deletion. Alerts use a
silent H.264 MP4 through Telegram's animation API for compact inline looping and
show the current SOL-denominated market cap calculated from verified on-chain
Pump reserves. It is not a market-wide buy feed.

Admins can start a voluntary X engagement prompt with
`/raid https://x.com/WetzelSOL/status/POST_ID`. The bot accepts only posts and
replies matching the configured official X profile and provides links for
members to open, like, bookmark, repost, or reply on X themselves. Live counts
are omitted because supported X API reads are paid. The bot does not perform,
verify, reward, count, or attribute engagement.

Admins can post and silently pin the verified onboarding panel with `/pinwelcome`.
Create a source-specific invite with `/invite x-profile` and view aggregate join
counts with `/campaigns`. Campaign events are stored in the ignored
`TELEGRAM_CAMPAIGN_LOG_PATH` JSONL file with the campaign, timestamp, chat ID,
and Telegram update ID only; member identities are not retained. Start an
anonymous native Telegram poll with `/poll Question | Option 1 | Option 2`.

If a bot token was ever posted in chat or source, revoke it in `@BotFather`
before proceeding. Put replacement tokens only in the ignored `.env` file.

1. Add both bots to the private group. Make only `@WetzelSOLModBot` an admin.
2. Grant the moderator permission to delete messages, restrict users, and pin
    messages. Disable its privacy mode with BotFather `/setprivacy` so it can
    enforce flood and forwarded-promotion rules.
3. Set `TELEGRAM_MOD_BOT_TOKEN` locally, run `npm.cmd run telegram-mod`, then
    issue `/chatid` in the group as an admin.
4. Stop the bot, place the returned negative ID in `TELEGRAM_GROUP_CHAT_ID`, add
    `TELEGRAM_ALERT_BOT_TOKEN`, then restart `npm.cmd run telegram-mod` and run
    `npm.cmd run telegram-alerts` in a second process.

The invite link is deliberately not stored in source. Telegram tokens never
belong in commands, logs, screenshots, issues, commits, or chat messages.

### Local process supervision

PM2 keeps both bot processes alive and restarts them after an application
failure. On Windows, the `Snipa Telegram Bots` scheduled task restores the saved
PM2 process list when the current user logs in. The machine must be powered on,
connected to the internet, and signed in; this is not a remote server deployment.

```powershell
npm.cmd run bots:status
npm.cmd run bots:logs
npm.cmd run bots:restart
npm.cmd run bots:stop
npm.cmd run bots:start
```

After changing `.env`, use `npm.cmd run bots:restart` to reload it. Keep bot
tokens only in `.env`.

Trade decisions are appended as a versioned JSON Lines event stream to
`TRADE_JOURNAL_PATH` (default `./trades.jsonl`). A stable decision ID links the
candidate, policy approval, simulation, submission, and terminal records. Each
snapshot includes decision inputs, stage timestamps, route, fee bounds,
simulation details, signature when submitted, and a rejection reason on failure.
Policy-approved live records preserve the decoded compute-unit limit, unit price,
and worst-case priority fee. Simulation records preserve consumed units and
ceiling utilization basis points; malformed or over-limit consumption fails
closed. A live buy also fails closed when RPC simulation omits consumed units,
after the raw simulation result is durably recorded; sell exits may proceed with
that optional field unavailable. Set optional `MIN_COMPUTE_HEADROOM_BPS` to an
operator-approved margin (`1000` means 10%); live buys whose simulation leaves
less headroom are rejected after journaling, while no margin is assumed by
default and sell exits bypass this entry-only rule.
Remote routes without a trusted quote record `expectedOutput` as `null` rather
than treating unverified output as a decision input. Set
`TRADE_JOURNAL_ENABLED=false` to disable best-effort paper and sell journaling;
live buys are blocked when journaling is disabled or when any candidate,
policy-approved, or simulation-completed append fails. Sell exits remain available
when the journal is unavailable so audit storage cannot strand an existing
position. Post-submission journal failure cannot interrupt confirmation handling.
Live buys are serialized within one process and unresolved signed submissions are
reconciled at confirmed commitment before another live buy may proceed. Unknown,
processed, RPC-failed, or reconciliation-journal-failed outcomes remain fenced;
an atomic `<TRADE_JOURNAL_PATH>.live-buy.lock` directory also excludes other
Snipa processes using the same journal. The directory contains non-secret PID,
host, acquisition-time, and journal-path metadata and is removed after normal
completion. A crash intentionally leaves it in place: verify that no Snipa
process using that journal is active before manually removing the lock directory.
After semantic policy validation, the remote transaction blockhash is replaced
with a fresh confirmed hash from the configured RPC before local signing. Its
last valid block height is journaled and used for expiry-aware confirmation; the
hash is checked again after simulation immediately before submission. Internal
RPC retries reuse identical signed bytes and therefore the same transaction
signature.
Journal files are excluded from Git.

Unique decoded token detections are also queued before filtering and written
asynchronously to `DASHBOARD_EVENT_LOG_PATH` (default
`./dashboard-events.jsonl`). `DASHBOARD_EVENT_QUEUE_CAPACITY` bounds pending
writes. A full queue or failed sink increments observable publisher health
counters and never waits in the detection path; projection JSONL is rebuildable
telemetry and does not replace the authoritative trade journal.
The scanner projection reducer replays detections and status transitions
idempotently. Unknown-token, mint-mismatched, time- or stage-regressive, and
terminal-rewrite events are rejected; skipped and rejected states require exact
reasons. Each token's first decision-stage event may record local
observation-to-decision latency. This measures time after the PumpPortal message
reaches the monitor; it is not source, network, validator, or landing latency.

Start the loopback-only scanner dashboard without loading a wallet during startup
or read-only requests:

```powershell
npm.cmd run dashboard-api
```

Open `http://127.0.0.1:8787` for the responsive live scanner. It shows projection
health, real token counts, search and status filters, stage and outcome fields,
deterministic sorting, locally persisted token pins, unavailable markers for
analytics not yet implemented, and exact decision findings in a token detail
drawer. The drawer's decision timeline contains only accepted projection events,
in replay order, with their recorded stage, status, timestamp, and exact reasons.
Sorting and pinning are browser preferences and cannot change engine decisions.
Opening a token also loads its deepest indexed Solana pool from GeckoTerminal,
shows a live 120-minute USD candlestick chart, current price, liquidity, 24-hour
change and volume, and the latest 30 indexed swaps with Solscan transaction and
wallet links. The drawer refreshes every 15 seconds while open. New launches may
show market data as unavailable until GeckoTerminal indexes a pool; provider data
is informational and is not used as an execution quote.
The main scanner table includes a Pump.fun link and a Quick Buy action for every
token. The toolbar amount is shared by all row actions, capped by the server's
configured maximum, and persisted locally in the browser. Every row buy shows an
explicit LIVE or PAPER confirmation and uses the same protected manual-buy
command path as the token drawer. The scanner can sort indexed market caps in
either direction, with unavailable values kept at the end.

The table polls USD market capitalization every five seconds for the 90 newest
scanner mints from DexScreener's batched Solana token endpoint. Each value comes
from the token's highest-liquidity indexed pool where that mint is the base
token. New launches show `Indexing` until a qualifying pool and market-cap value
are available; older rows show `Outside fast window`. The response is cached for
60 seconds while its mint set is unchanged to bound provider and RPC load. `Paid
boosts` is DexScreener's active paid-boost count for that same pool;
it measures purchased visibility, not legitimacy, organic demand, or expected
profitability.
The `Active traders (5m)` column is an attention proxy from GeckoTerminal's top
indexed pool, calculated as five-minute buyers plus sellers. A wallet active on
both sides may be counted twice, so this is not a unique visitor count. Both sort
directions keep unavailable values last. To respect public provider limits, the
dashboard refreshes the 30 most recently detected tokens every 60 seconds.
The same bounded pool batch provides buy pressure (five-minute buys divided by
all five-minute trades) and volume acceleration (the five-minute volume pace
divided by the preceding ten-minute pace). Liquidity comes from the deepest
DexScreener pool. Verified Pump accounts provide bonding-curve progress, with
migrated tokens shown at 100%. Top-10 account concentration is calculated from
raw RPC token balances and total supply for the five newest tokens every five
minutes; it may include pools or bonding-curve accounts and is not an identity-
level holder metric. Every signal can be sorted in either direction, with
unavailable values last.
Each detected token also has a clearly labeled manual-buy control capped by
`BUY_AMOUNT_SOL`. Submitting it requires confirmation,
a fresh command UUID and timestamp, same-origin and CSRF validation, and an exact
mint already present in the scanner projection. Duplicate command IDs execute at
most once. The server loads the wallet only after these checks and delegates to
the same guarded `executeTrade` path used by the CLI. Paper mode records the trade
without constructing or broadcasting a transaction. Live mode additionally
requires the live-trading arm, wallet reserve, simulation, transaction-policy,
signing, broadcast, confirmation, and durable command-audit checks.

`GET /api/scanner` returns replayed token rows and accepts optional `status` and
`limit` query parameters. `GET /api/health` reports projection-log replay and
latest launch-stream continuity health. `GET /api/control` returns only ephemeral
browser control metadata. `POST /api/manual-buy` accepts protected paper-buy
commands and never returns signing material or wallet configuration.
`GET /api/token-market?mint=<mint>` proxies normalized public pool, candle, and
swap data only for mints already present in the scanner projection and caches it
briefly to respect provider limits.
`GET /api/token-activity` returns the bounded, cached five-minute active-trader
proxy for scanner mints only.
`GET /api/holder-concentration` returns the bounded, cached top-10 token-account
concentration for scanner mints only.
Both endpoints expose the latest accepted event timestamp, event age, configured
stale threshold, stale state, and replayed observation-to-decision sample count,
P50, P95, and maximum. The UI labels stale projections explicitly
instead of treating a newly generated API response as fresh market data. Set
`DASHBOARD_PROJECTION_STALE_AFTER_MS` to tune the threshold (default `60000`).
The host is restricted to `127.0.0.1` or `::1` through `DASHBOARD_API_HOST`, with
port `8787` by default. Responses disable caching and include no wallet secrets,
provider credentials, or signing capability.

Summarize the journal without loading a wallet:

```powershell
npm.cmd run history
```

The summary counts terminal decisions rather than lifecycle events and reports
recorded SOL buy spend and trade counts. It does not claim profit and loss
because percentage-based sell records do not contain proceeds. For confirmed
live v2 records with complete timestamps, it also reports nearest-rank P50/P95/
maximum submission-to-confirmation observation latency and counts regressive
timestamp pairs separately. This is local confirmation observation, not a
validator landing timestamp. Set optional `SUBMISSION_CONFIRMATION_ALERT_MS` to
a positive integer to count samples above an operator-approved threshold and
report P95 as `OK`, `ALERT`, or `NO_SAMPLES`; no threshold is assumed by default.

## Live trading

Test paper mode first. To permit live manual orders, set `LIVE_TRADING=true`.
For event-driven buys, both `LIVE_TRADING=true` and `AUTO_BUY=true` must be set.
Live execution also requires `LIVE_TRADING_ARM_PATH` to point to a file whose
only content is the exact acknowledgement below:

```powershell
Set-Content -NoNewline live-trading.armed "I_ACKNOWLEDGE_LIVE_TRADING_RISK"
```

Delete the file to disarm subsequent execution immediately:

```powershell
Remove-Item live-trading.armed
```

The CLI requests a serialized transaction from PumpPortal's local trading API,
validates its signer, programs, trade discriminator, mint, account roles, quote
mint, argument shape, and aggregate buy-spend limit, signs it with the configured
wallet, simulates it through `SOLANA_RPC_URL`, and only then broadcasts it. The
default allowlist supports official Pump and PumpSwap execution; other venues
remain blocked until they have dedicated decoders and validation.

Before live buy route construction, the mint account's authoritative bytes are
decoded as the classic 82-byte SPL Token Mint layout. The account must be
initialized and non-executable with nonzero supply, valid authority option tags,
and both mint and freeze authorities revoked. The accepted program, decimals,
supply, and authority state are durably journaled as `asset-validated`.
Token-2022 and extension-sized mints remain rejected until dedicated extension
policies exist; the Token-2022 program owner is identified explicitly, but its
account and extension data are not yet decoded. Sell exits bypass this entry-only
gate.

Live sells additionally decode the wallet's authoritative token-account bytes
before calling PumpPortal. Program-owner, executable, layout, COption-tag, state,
mint, wallet-owner, and raw-balance mismatches are journaled as local rejections.
Numeric sells separately decode classic mint decimals while permitting active
mint or freeze authorities so an entry-only rule cannot strand an exit.
Token-2022 exits remain unsupported. A nonzero encoded minimum output prevents an
entirely unbounded sell, but it is not yet a trusted slippage floor: live strategy
exits remain incomplete until a caller-approved quote supplies minimum proceeds
independently of PumpPortal.

`MAX_TRADE_INTENT_AGE_MS` sets the current shared live intent lifetime (default
`10000`). The boundary is inclusive; an age greater than the configured value is
journaled as a rejection. This is a wall-clock guard, not a substitute for future
quote-age, slot-age, or price-movement checks.

Adding a program ID to `ALLOWED_PROGRAM_IDS` does not authorize its instructions
without a corresponding decoder policy. Transactions that require top-level
System or SPL Token setup are intentionally rejected until state-aware WSOL
funding and cleanup validation is implemented.

Public Solana RPC endpoints are rate limited. Use a reputable private RPC for
reliable operation. The monitor automatically reconnects after a dropped
PumpPortal connection with exponential backoff capped at 30 seconds. Stop it
with Ctrl+C.

## Development

```powershell
npm.cmd run check
npm.cmd test
```
