# AH Corner — v0.1.0

Local-first, manual-execution market intelligence for World of Warcraft: Forever. Defaults: US PvP Horde, 35g strategy bankroll, 35% per-trade exposure, 30% minimum potential ROI, 5% faction auction fee. No automated game interaction. Not affiliated with Blizzard.

## Run locally

Node 22.13+ and npm are required. A local JSON store is intentionally available for a disposable demo when `DATABASE_URL` is blank; it is not used by the Docker deployment.

```bash
cp .env.example .env
npm ci
npm run build
npm run server
```

Open http://127.0.0.1:3000. The default **demo** mode loads synthetic hourly data, provides a working scanner and journal, and disables live alerts and actionable addon exports. Demo and live state are separated. For UI development, run `npm run server` in one terminal and `npm run dev` in another (http://127.0.0.1:5173).

## Docker deployment with an existing MySQL or MariaDB server

The Docker Compose file starts **only the AH Corner application**. It never starts a database or generates a database URL. The app container connects to the MySQL or MariaDB server you already operate.

1. A dedicated `ahcorner` database and least-privilege user are preferred, but an existing shared schema is supported: AH Corner creates `ah_corner_state`, `ah_corner_snapshots`, `ah_corner_price_history`, and `ah_corner_schema_migrations`. Keep those names reserved for this app. The runtime user needs `SELECT`, `INSERT`, `UPDATE`, and `DELETE` on the first three tables plus `SELECT` on the migration table. Run `npm run migrate` with a user allowed to create and later alter those tables; set that optional connection as `DATABASE_MIGRATION_URL` (or use `DATABASE_URL` for the simplest initial setup).
2. Copy `.env.example` to `.env` and set a `mysql://` `DATABASE_URL`, for example `mysql://ahcorner_runtime:encoded-password@host.docker.internal:3306/shared_database`. Percent-encode reserved username/password characters. Do not put TLS settings in the URL: use `DATABASE_SSL=verify-full` for a TLS MySQL/MariaDB connection and, for a private CA, mount its PEM certificate into the container and set `DATABASE_SSL_CA_FILE` to the in-container path. `DATABASE_SSL=disable` is appropriate only for a deliberately private local database link, such as the Docker-host gateway.
3. Set `APP_TRUSTED_HOSTS` and `APP_TRUSTED_ORIGINS` to the exact public hostname and HTTPS origin used by your reverse proxy. Keep `BIND_ADDRESS=127.0.0.1` unless the proxy is on another machine.
4. Build, migrate once, then start the single application container:

```bash
docker compose build app
docker compose run --rm app npm run migrate
docker compose up -d app
docker compose logs -f app
```

When MySQL/MariaDB is on the same Docker host, Compose maps `host.docker.internal` to Docker's host gateway, so the container can reach the bare-metal database without publishing MySQL in another container. Otherwise use the database server's DNS name or private IP and allow the Docker host through MySQL's bind address and user grants. The app exposes `/livez` and database-aware `/readyz`; Compose uses `/readyz` as its health check. A missing URL, an uninitialized schema, an invalid MySQL URL, or a database outage produces a specific startup/readiness error instead of silently falling back to local files.

Use a TLS reverse proxy when exposing the app. Set `REQUIRE_AUTH=true` to require Muzzle Slack sign-in; production mode refuses to start without it. This requires the Muzzle Slack exchange endpoint to be deployed. Sessions are held in memory and expire after at most 24 hours, so restarting the app signs users out. Local development can leave authentication disabled. Use the MySQL/MariaDB server's backups and practice restores. The app retains at most 25 raw snapshots per market plus compact hourly price observations for up to 30 days.

For the current `muzzle.lol` host layout, use the tailored [deployment guide](docs/muzzle-lol-deployment.md).

## Connect live Blizzard data

1. Create an API client at https://develop.battle.net/ and accept the applicable developer terms. This uses OAuth client credentials, not your account password. Put the ID and secret into your local `.env` only. Do not paste them into chat or commit the file. `chmod 600 .env` is recommended.
2. `REGION=us`, `RULESET_ID=1` are preconfigured. Discover Horde auction houses, while comparing current in-game Linen Cloth (2589) and Copper Ore (2770) floors and units at those floors. You may substitute other high-volume item IDs. From the Docker project directory, with the demo stack already built:

```bash
docker compose run --rm app npm run discover -- 2589 2770
# or on the host after copying .env:
npm run discover -- 2589 2770
```

3. Compare **both** items with the in-game AH. `floor` is copper per unit, `floorUnits` is quantity at that floor. Several houses have identical Horde names and community reports indicate ruleset filtering may be unreliable. If nothing matches, wait for a fresh snapshot or use another item pair; do not set verification prematurely. To collect from a provisional house before verification, explicitly set `ALLOW_UNVERIFIED_HOUSE=true` while keeping `HOUSE_VERIFIED=false`: the dashboard warns that the market may not match your realm, and treats all opportunities as watch-only while disabling alerts, backtests and addon plans.
4. In `.env`, set `HOUSE_ID=<confirmed numeric ID>`, `HOUSE_VERIFIED=true`, `MODE=live`. For Docker, run `docker compose up -d --force-recreate app`; for local use, restart the server. Live collection starts immediately; the hosted deployment uses cron at the top of each hour, while the optional in-process scheduler uses `POLL_MINUTES=60`. A successful check records the latest observed price for each item per hour, even if the book did not change; Blizzard's source may itself update less often. Watch collector status; after at least six prior observations and sufficient price support, candidates may qualify. A new market has watch-only candidates until history accumulates. If the house becomes inconsistent, stop and reverify.
5. Optionally set `ALERT_WEBHOOK_URL` to a private Discord-compatible webhook and recreate the app. The app stores alerts locally and sends qualifying live candidates to that URL; no outbound alerts in demo or provisional markets. Alerts use the saved market strategy and item-use evidence. The dashboard polls every 30 seconds. Webhook delivery is best-effort, not a guaranteed push channel; failed deliveries are logged, not retried. Keep the webhook secret.

### Market settings

`BANKROLL_GOLD`, `MAX_EXPOSURE`, `MIN_ROI`, `MIN_PROFIT_GOLD`, `AH_FEE`, `MIN_HISTORY`, `COLLECT_SCHEDULE`, and `POLL_MINUTES` provide initial defaults in `.env.example`. Choose `COLLECT_SCHEDULE=cron` with the host job or `interval` with the built-in timer; do not run both schedules. Save bankroll, maximum exposure, minimum ROI and potential profit, AH fee, and minimum observations directly in the dashboard; these settings persist per market and apply to scanning, alerts, backtests, and addon plans. Maximum exposure is a per-candidate limit, **not** a portfolio-wide cash reservation; never execute multiple overlapping plans without checking actual remaining gold. Watchlist is a UI filter. Prices are integer copper internally. Actual bids and variant gear are excluded. The app handles whole regular auction stacks and unit-priced commodities separately and skips mixed books for the same item ID. It does not calculate item-specific AH deposits automatically.

Crafting ingredients are identified automatically from the versioned [Warcraft Forever recipe data](https://warcraftforever.com/developers/data/), refreshed in the background and stored in the market's MySQL-backed state. The app saves one example recipe per ingredient; a missing recipe does not mean the item has no use, and a recipe does not establish availability, demand, or sales. The last complete index remains available if an update fails. This source does not supply quest data. Use **Record item-use research** to note a quest, profession, consumable, equipment, or other use and its source, or exclude an item from the queue. Your assessment takes precedence over automatic recipe evidence; choosing Unknown clears that override. Items without either form of evidence remain watch-only. Backtests do not apply evidence retroactively to decisions before it was recorded. Items link to Wowhead's Forever database; names are looked up from Blizzard with bounded background requests. If Forever has no item record, the app tries Classic Era and then Classic progression and labels the fallback source. A Classic name does not establish that an item has the same name or use in Forever. Items without a name in any source are hidden by default and can be included explicitly.

## Scanner methodology

- Sort price tiers, calculate cumulative cost to acquire every listed unit through each tier, then evaluate resale at one copper below the next competing tier. Do not buy arbitrary partial regular stacks. The maximum unit acquisition price is shown.
- Estimate proceeds after commission (conservatively rounded per unit), hypothetical upside, break-even units, and the number of listings in the buyout. Minimum potential profit can filter out low-value work. Profit per listed auction is not gold per hour or proof that the item will sell; commodity purchases need not correspond to one click per listing. Unsold units, deposits and opportunity cost are excluded from projected cash profit.
- Candidate gating requires a player-noted item use or an indexed recipe ingredient, at least six prior item observations by default, target supported by at least 25% of prior floors and at/below historical 75th percentile, positive observed removals, replenishment no faster than removals, and fresh data. Otherwise watch-only; excluded items are omitted. Provisional house mappings remain watch-only regardless of evidence. Score uses removal velocity 25%, ROI 25%, cost 20%, replenishment 15%, historical support 10%, freshness 5%. Weights are heuristics, not calibrated probabilities.
- Removed listings/quantity can mean sales, cancellations, expiration or changes. They are not verified trades. Backtest is a conservative *forward price support diagnostic*: compare candidate target with the next observed competing book, without claiming simulated sales or realized profits. It is not a causal execution simulation; the historical book did not actually undergo your buyout. It does not model queue priority, demand elasticity or fills.
- History retention: the last 25 distinct raw books per market are used for the scanner and backtest. A separate compact series retains each item's latest successful observation per hour, up to 30 days for Blizzard data; timestamps are when the app observed the book, not a guarantee of when Blizzard published it. Live historical prices, raw books, names and generated alerts expire after 30 days; user-entered trades and watchlists are preserved. The hourly job performs cleanup, including after a fetch fails; backups and external copies need their own retention policy. Blizzard's Developer API terms require a maximum 30-day TTL for API data; review the current terms for your use. Larger markets can still require substantial RAM/storage (allow at least 2–4 GB). No historic market data is bundled apart from synthetic fixtures.
- Backtest, alerts and addon plans use saved market settings and item-use evidence. Data is delayed, and every candidate needs actual manual in-game verification. If the lowest tier is replenishing faster than you can sell, stop defending the reset.

## Companion addon

Copy `addon/AHCorner` into the actual Forever client's `Interface/AddOns/` directory (client folder name varies). Launch WoW and enable AH Corner. The community-reported interface version is 16001; verify with `/dump select(4, GetBuildInfo())` if the client changes. It contains no scanning or purchasing code, does not access game memory, and doesn't simulate inputs. It is an advisory slash-command plan viewer plus a manually entered trade journal, **not** an automatic transaction listener or custom AH UI.

In live mode, export `Plan.lua` from the dashboard and replace the addon's `Plan.lua` while logged out; log in and use `/ahc plan`. Plans older than two hours are rejected. You must search, compare and execute in the standard AH UI yourself. Only qualifying fresh live candidates are exported; a demo plan intentionally has no rows.

After a completed manual transaction, record the actual amount, including AH commission or nonrefunded deposit as fee where applicable. Examples (1g = 10000 copper):

```text
/ahc buy 4402 10 8000 0
/ahc sell 4402 5 7500 375
/ahc count
```

Use `/reload` or log out so SavedVariables are flushed. In the Portfolio tab, import `WTF/Account/<account>/SavedVariables/AHCorner.lua` from the same client. Import is idempotent by record ID, parses a restricted record format without executing Lua, and only tracks manually confirmed trades. Do not import actual transactions into demo mode. The portfolio uses weighted-average cost; unmatched sales are marked and excluded from realized P/L. Record gross amounts and actual fees, not both net amounts and fees. Separate lost deposits or adjustments currently need to be incorporated manually into a related transaction. The journal does not edit/delete transactions in this release.

## Validation and limitations

```bash
npm test
bash scripts/smoke.sh
npm run typecheck
npm run build
```

Tests include normalization, stack economics, caps, mixed auction types, synthetic scoring/backtest, accounting, safe journal parsing, mocked OAuth/collector response handling, database fail-closed configuration, health endpoints, and safe validation errors. The smoke script boots the demo backend in a temporary data directory and checks API behavior end to end. See `TEST-RESULTS.md` for the current validation record. Live Blizzard authentication, webhook delivery, reverse-proxy authentication, bare-metal MySQL/MariaDB connectivity/TLS, backup restore, and in-game addon behavior must still be validated in the target environment. No live gold has been spent. This is a first implementation, not a production-certified service.

## API references / implementation provenance

Forever's routes are community-discovered, not a stable official contract. The client uses `dynamic-forever-us`, the `/data/wow/ruleset/{id}/auctions/` index (trailing slash), per-house auctions and, when needed, the `/commodities` endpoint; static item lookup uses `static-forever-us`. It caches OAuth, retries 429/5xx, fetches complete books on each check, and deduplicates raw books by content. Missing commodity arrays or empty regular books fail closed. Observation time is local receipt time (not guaranteed publication time). Some endpoints may change. Sources consulted on 2026-11-24:

- https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334
- https://www.blizzard.com/en-us/legal/a2989b50-5f16-43b1-abec-2ae17cc09dd6/blizzard-developer-api-terms-of-use
- https://github.com/ChipWhiteside/WoW-Forever-Market-Analysis/blob/main/wow-forever-session-files/docs/wow-forever-blizzard-api-setup.md
- https://github.com/cnanas/Wow-Forever-Auction
- https://github.com/petersutarik/wow-forever-ah (MIT; reviewed architecture only)
- https://github.com/derek-etherton/Arbitrage (community-reported client interface version)
- https://us.forums.blizzard.com/en/wow/t/wow-code-of-conduct-and-addons/2329460

All application and addon source in this bundle was written for this project; no third-party repository code was copied. Dependencies retain their respective licenses. Check Blizzard's current applicable terms and addon rules before use. Do not automate purchases, posts, cancels, game inputs, or bypass throttling.
