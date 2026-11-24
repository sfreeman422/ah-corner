# Test results — v0.1.0

Validated on 2026-11-24 with Node.js 24.21.0 and npm 11.19.0:

- `npm ci` resolved the pinned dependency graph and generated `package-lock.json`.
- `npm test` passed: mocked Blizzard collection, scanner/accounting, journal safety, and production-style database fail-closed checks.
- `bash scripts/smoke.sh` passed: demo API startup, `/livez`, `/readyz`, scanner, history, backtest, watchlist, journal idempotency, safe validation errors, portfolio accounting, alert isolation, and demo addon export.
- `npm run typecheck` passed.
- `npm run build` passed with Vite 6.4.6.
- `npm audit` reported no known production or development dependency vulnerabilities.
- `docker compose config --quiet` passed. A Docker image build and a live MySQL/MariaDB migration were not run here because this account cannot access the local Docker daemon and no target database credentials were supplied.
- Live Blizzard collection, webhook delivery, reverse-proxy authentication, bare-metal MySQL/MariaDB connectivity/TLS, backup restore, and in-game addon behavior still require validation in the target environment.
