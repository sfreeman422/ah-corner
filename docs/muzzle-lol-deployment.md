# Deploying AH Corner on muzzle.lol

This deploys one AH Corner Docker container. MySQL remains the existing bare-metal service on the host; no database container, cluster, or scaling layer is added. It does not read, reuse, or alter the existing Muzzle application's credentials or tables.

## Host layout

- AH Corner binds to `127.0.0.1:3003`; port 3000 remains reserved for Muzzle.
- The host MySQL service listens on Docker's bridge gateway (`172.17.0.1:3306`). Compose maps that address to `host.docker.internal` inside the AH Corner container.
- `ah.muzzle.lol` already resolves to the host, but needs its own Nginx virtual host and certificate.

## MySQL setup

Use the existing MySQL server, preferably with a dedicated `ahcorner` schema and two application-specific users. This remains one shared MySQL service while avoiding collisions and broad access to the Muzzle schema. Run the following in an interactive, privileged MySQL session. Replace the two password placeholders with distinct randomly generated hexadecimal passwords; do not put them in this document or commit them.

```sql
CREATE DATABASE IF NOT EXISTS ahcorner CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'ahcorner_runtime'@'172.17.%' IDENTIFIED BY '<runtime-password>';
CREATE USER IF NOT EXISTS 'ahcorner_migrate'@'172.17.%' IDENTIFIED BY '<migration-password>';

GRANT SELECT, INSERT, UPDATE, DELETE ON ahcorner.* TO 'ahcorner_runtime'@'172.17.%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON ahcorner.* TO 'ahcorner_migrate'@'172.17.%';
FLUSH PRIVILEGES;
```

If the existing Muzzle schema must be used instead, AH Corner uses only `ah_corner_state`, `ah_corner_snapshots`, and `ah_corner_schema_migrations`. Reserve those names and give the runtime user table-level `SELECT`, `INSERT`, `UPDATE`, and `DELETE` after the first migration. A dedicated schema is safer because future migrations will need controlled schema privileges.

## Application deployment

```bash
git clone https://github.com/sfreeman422/ah-corner.git /home/muzzle.lol/ah-corner
cd /home/muzzle.lol/ah-corner
cp .env.example .env
chmod 600 .env
```

Set these values in `/home/muzzle.lol/ah-corner/.env`; leave the other application settings as appropriate. The passwords below are placeholders, not literal values.

```dotenv
DATABASE_URL=mysql://ahcorner_runtime:<runtime-password>@host.docker.internal:3306/ahcorner
DATABASE_MIGRATION_URL=mysql://ahcorner_migrate:<migration-password>@host.docker.internal:3306/ahcorner
DATABASE_SSL=disable
REQUIRE_DATABASE_SSL=false
BIND_ADDRESS=127.0.0.1
HOST_PORT=3003
APP_TRUSTED_HOSTS=ah.muzzle.lol
APP_TRUSTED_ORIGINS=https://ah.muzzle.lol
```

Hex passwords need no URL escaping. For other passwords, percent-encode reserved URL characters. `DATABASE_SSL=disable` is intentional here because the container reaches the local host across Docker's private bridge; do not expose MySQL publicly. For a remote database, use `DATABASE_SSL=verify-full` and a CA file instead.

Build, migrate, and start the one service:

```bash
cd /home/muzzle.lol/ah-corner
docker compose build app
docker compose run --rm app npm run migrate
docker compose up -d app
curl -fsS http://127.0.0.1:3003/readyz
```

If migration fails, its message distinguishes an invalid URL, missing privileges, an unavailable MySQL service, and migration-lock contention. Do not start the public proxy until `/readyz` succeeds.

## Nginx and HTTPS

Create an Nginx vhost for only `ah.muzzle.lol`, proxying to `127.0.0.1:3003`; do not modify the existing `muzzle.lol` or `api.muzzle.lol` vhosts. Require authentication before public exposure. A minimal authenticated proxy location is:

```nginx
location / {
    auth_basic "AH Corner";
    auth_basic_user_file /etc/nginx/.htpasswd-ah-corner;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3003;
}
```

After testing the configuration with `sudo nginx -t`, reload it and issue a dedicated certificate with `sudo certbot --nginx -d ah.muzzle.lol`. Create the htpasswd file with `sudo htpasswd -c /etc/nginx/.htpasswd-ah-corner <admin-user>` (install `apache2-utils` first if `htpasswd` is absent). Then verify both the loopback readiness endpoint and the authenticated HTTPS site.

## Updating

```bash
cd /home/muzzle.lol/ah-corner
git pull --ff-only
docker compose build app
docker compose run --rm app npm run migrate
docker compose up -d app
docker compose logs --tail=100 app
```

The migration step is safe to repeat. Keep `.env` only on the host; it is ignored by Git.
