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

## Docker deployment with an existing PostgreSQL server

The Docker Compose file starts **only the AH Corner application**. It never starts PostgreSQL or generates a database URL. The app container connects to the PostgreSQL server you already operate.

1. Create an application database and a least-privilege runtime role. For the first migration, use a separate migrator role that can create tables; set its URL as `DATABASE_MIGRATION_URL`. The runtime `DATABASE_URL` needs only access to AH Corner's tables plus `SELECT` on `schema_migrations`.
2. Copy `.env.example` to `.env`, set `DATABASE_URL`, and choose `DATABASE_SSL=verify-full` for a TLS PostgreSQL connection. Do not add `sslmode` parameters to the URL: TLS policy is controlled by `DATABASE_SSL`. If the server uses a private CA, mount its PEM certificate into the container and set `DATABASE_SSL_CA_FILE` to that in-container path. `DATABASE_SSL=disable` is only appropriate when you deliberately operate a private local database link.
3. Set `APP_TRUSTED_HOSTS` and `APP_TRUSTED_ORIGINS` to the exact public hostname and HTTPS origin used by your reverse proxy. Keep `BIND_ADDRESS=127.0.0.1` unless the proxy is on another machine.
4. Build, migrate once, then start the single application container:

```bash
docker compose build app
docker compose run --rm app npm run migrate
docker compose up -d app
docker compose logs -f app
```

When PostgreSQL is on the same Docker host, `host.docker.internal` is available inside the container as a convenient hostname. Otherwise use the database server's DNS name or private IP and allow the Docker host through PostgreSQL's network policy. The app exposes `/livez` and database-aware `/readyz`; Compose uses `/readyz` as its health check.

Put an authenticated TLS reverse proxy in front of the application before exposing it to anyone. Host/origin checks are not authentication. The app is single-user today, so do not make it public without an access-control layer. Use the PostgreSQL server's backups/PITR and practice restores; the app intentionally retains only the newest 25 raw snapshots per market.

## Connect live Blizzard data

1. Create an API client at https://develop.battle.net/ and accept the applicable developer terms. This uses OAuth client credentials, not your account password. Put the ID and secret into your local `.env` only. Do not paste them into chat or commit the file. `chmod 600 .env` is recommended.
2. `REGION=us`, `RULESET_ID=1` are preconfigured. Discover Horde auction houses, while comparing current in-game Linen Cloth (2589) and Copper Ore (2770) floors and units at those floors. You may substitute other high-volume item IDs. From the Docker project directory, with the demo stack already built:

```bash
docker compose run --rm app npm run discover -- 2589 2770
# or on the host after copying .env:
npm run discover -- 2589 2770
```

3. Compare **both** items with the in-game AH. `floor` is copper per unit, `floorUnits` is quantity at that floor. Do not guess the house ID; several houses have identical Horde names and community reports indicate ruleset filtering may be unreliable. The collector will not start in live mode until an explicit ID and manual verification flag are supplied. If nothing matches, wait for a fresh snapshot or use another item pair; do not set verification prematurely.
4. In `.env`, set `HOUSE_ID=<confirmed numeric ID>`, `HOUSE_VERIFIED=true`, `MODE=live`. For Docker, run `docker compose up -d --force-recreate app`; for local use, restart the server. Live collection starts immediately and polls every 15 minutes, typically receiving new data about hourly. Watch collector status; after at least six prior observations and sufficient price support, candidates may qualify. A new market has watch-only candidates until history accumulates. If the house becomes inconsistent, stop and reverify.
5. Optionally set `ALERT_WEBHOOK_URL` to a private Discord-compatible webhook and recreate the app. The app stores alerts locally and sends qualifying live candidates to that URL; no outbound alerts in demo. Alerts are based on server settings in `.env`, not transient dashboard controls. The dashboard polls every 30 seconds. Webhook delivery is best-effort, not a guaranteed push channel; failed deliveries are logged, not retried. Keep the webhook secret.

### Market settings

`BANKROLL_GOLD`, `MAX_EXPOSURE`, `MIN_ROI`, `AH_FEE`, `MIN_HISTORY` and `POLL_MINUTES` are in `.env.example`. Current default bankroll is 35g; update to actual available cash. The UI lets you experiment with different bankroll and ROI filters without altering the server alert settings. `MAX_EXPOSURE` is a per-candidate limit, **not** a portfolio-wide cash reservation; never execute multiple overlapping plans without checking actual remaining gold. Watchlist is a UI filter. Prices are integer copper internally. Actual bids and variant gear are excluded; unresolved names remain item IDs. The app handles whole regular auction stacks and unit-priced commodities separately and skips mixed books for the same item ID. It does not calculate item-specific AH deposits automatically.

## Scanner methodology

- Sort price tiers, calculate cumulative cost to acquire every listed unit through each tier, then evaluate resale at one copper below the next competing tier. Do not buy arbitrary partial regular stacks. The maximum unit acquisition price is shown.
- Estimate proceeds after commission (conservatively rounded per unit), hypothetical upside and break-even units. Unsold units, deposits and opportunity cost are excluded from projected cash profit. Nothing is a guaranteed sale.
- Candidate gating: at least six prior item observations by default, target supported by at least 25% of prior floors and at/below historical 75th percentile, positive observed removals, replenishment no faster than removals, and fresh data. Otherwise watch-only. Score uses removal velocity 25%, ROI 25%, cost 20%, replenishment 15%, historical support 10%, freshness 5%. Weights are heuristics, not calibrated probabilities.
- Removed listings/quantity can mean sales, cancellations, expiration or changes. They are not verified trades. Backtest is a conservative *forward price support diagnostic*: compare candidate target with the next observed competing book, without claiming simulated sales or realized profits. It is not a causal execution simulation; the historical book did not actually undergo your buyout. It does not model queue priority, demand elasticity or fills.
- History retention: last 25 distinct raw snapshots per market (roughly one day at hourly refresh). This MVP intentionally bounds memory and disk use; larger markets can still require substantial RAM/storage (allow at least 2–4 GB). Raw snapshots are JSONB in PostgreSQL. Long-run analytics should move to compact aggregated time series and partitioned auction data; extended retention and incremental backtesting are future improvements. No historic market data is bundled apart from synthetic fixtures.
- Backtest, alerts and addon plan use server-configured settings. A dashboard filter is exploratory. Data is delayed, and every candidate needs actual manual in-game verification. If the lowest tier is replenishing faster than you can sell, stop defending the reset.

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

Tests include normalization, stack economics, caps, mixed auction types, synthetic scoring/backtest, accounting, safe journal parsing, mocked OAuth/collector response handling, database fail-closed configuration, health endpoints, and safe validation errors. The smoke script boots the demo backend in a temporary data directory and checks API behavior end to end. See `TEST-RESULTS.md` for the current validation record. Live Blizzard authentication, webhook delivery, reverse-proxy authentication, bare-metal PostgreSQL connectivity/TLS, backup restore, and in-game addon behavior must still be validated in the target environment. No live gold has been spent. This is a first implementation, not a production-certified service.

## API references / implementation provenance

Forever's routes are community-discovered, not a stable official contract. The client uses `dynamic-forever-us`, the `/data/wow/ruleset/{id}/auctions/` index (trailing slash), per-house auctions and, when needed, the `/commodities` endpoint; static item lookup uses `static-forever-us`. It caches OAuth, retries 429/5xx, requests unchanged snapshots conditionally and deduplicates content. Missing commodity arrays or empty regular books fail closed. If `Last-Modified` is absent, snapshot time is local receipt time (not guaranteed publication time). Some endpoints may change. Sources consulted on 2026-11-24:

- https://us.forums.blizzard.com/en/blizzard/t/wow-forever-api-what-works-so-far-plus-a-ts-client/60334
- https://github.com/ChipWhiteside/WoW-Forever-Market-Analysis/blob/main/wow-forever-session-files/docs/wow-forever-blizzard-api-setup.md
- https://github.com/cnanas/Wow-Forever-Auction
- https://github.com/petersutarik/wow-forever-ah (MIT; reviewed architecture only)
- https://github.com/derek-etherton/Arbitrage (community-reported client interface version)
- https://us.forums.blizzard.com/en/wow/t/wow-code-of-conduct-and-addons/2329460

All application and addon source in this bundle was written for this project; no third-party repository code was copied. Dependencies retain their respective licenses. Check Blizzard's current applicable terms and addon rules before use. Do not automate purchases, posts, cancels, game inputs, or bypass throttling.
