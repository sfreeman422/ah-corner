# Deploying AH Corner on muzzle.lol

This deploys one AH Corner Docker container. MySQL remains the existing bare-metal service on the host; no database container, cluster, or scaling layer is added. It does not read, reuse, or alter the existing Muzzle application's credentials or tables.

## Host layout

- AH Corner binds to `127.0.0.1:3003`; port 3000 remains reserved for Muzzle.
- The host MySQL service listens on Docker's bridge gateway (`172.17.0.1:3306`). Compose maps that address to `host.docker.internal` inside the AH Corner container. MySQL sees the container's source address from AH Corner's separate Compose network, not `172.17.0.0/16`; the bootstrap script determines that source range automatically.
- `ah.muzzle.lol` resolves to the host and requires its own Nginx virtual host and certificate; both are installed on the current target host.

## MySQL setup

Use the existing MySQL server with a dedicated `ahcorner` schema and two application-specific users. This remains one shared MySQL service while avoiding collisions and broad access to the Muzzle schema. The quickest safe setup is the tracked bootstrap script: it prompts for sudo, generates passwords without displaying them, writes the generated credentials only to the protected `.env`, migrates, and starts the container.

```bash
cd /home/muzzle.lol/ah-corner
bash scripts/bootstrap-muzzle-mysql.sh
```

Enter the MySQL root password at the MySQL prompt; it can differ from the sudo password. Do not run the script itself with `sudo` or paste either password into chat. For a MySQL installation that uses passwordless root socket authentication, run `AH_CORNER_MYSQL_AUTH=socket bash scripts/bootstrap-muzzle-mysql.sh` instead.

The script derives the exact Docker-network source range for the MySQL account grants. For a manual setup, first run `docker compose build app && docker compose create app`, then derive the range with `docker network inspect ah-corner_default --format '{{(index .IPAM.Config 0).Subnet}}'`. On the current host that range is `172.19.0.0/16`, so use `172.19.%` below. Replace the two password placeholders with distinct randomly generated hexadecimal passwords; do not put them in this document or commit them.

```sql
CREATE DATABASE IF NOT EXISTS ahcorner CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'ah_corner_runtime'@'172.19.%' IDENTIFIED BY '<runtime-password>';
CREATE USER IF NOT EXISTS 'ah_corner_migrate'@'172.19.%' IDENTIFIED BY '<migration-password>';

GRANT SELECT, INSERT, UPDATE, DELETE ON ahcorner.* TO 'ah_corner_runtime'@'172.19.%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON ahcorner.* TO 'ah_corner_migrate'@'172.19.%';
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
DATABASE_URL=mysql://ah_corner_runtime:<runtime-password>@host.docker.internal:3306/ahcorner
DATABASE_MIGRATION_URL=mysql://ah_corner_migrate:<migration-password>@host.docker.internal:3306/ahcorner
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
curl -fsS -H 'Host: ah.muzzle.lol' http://127.0.0.1:3003/readyz
```

If migration fails, its message distinguishes an invalid URL, missing privileges, an unavailable MySQL service, and migration-lock contention. Do not start the public proxy until `/readyz` succeeds.

## Nginx and HTTPS

The tracked [`deploy/nginx/ah.muzzle.lol.conf`](../deploy/nginx/ah.muzzle.lol.conf) proxies both the frontend and `/api/*` to the one AH Corner container at `127.0.0.1:3003`; do not modify the existing `muzzle.lol` or `api.muzzle.lol` vhosts. The AH Corner vhost is public and the app has no login: anyone who can reach it can view and modify its data. For a new installation, enable the vhost from the server's interactive SSH terminal:

```bash
cd /home/muzzle.lol/ah-corner
sudo cp deploy/nginx/ah.muzzle.lol.conf /etc/nginx/sites-available/ah.muzzle.lol
sudo ln -s /etc/nginx/sites-available/ah.muzzle.lol /etc/nginx/sites-enabled/ah.muzzle.lol
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx --redirect -d ah.muzzle.lol
```

The relevant proxy block is:

```nginx
location / {
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_pass http://127.0.0.1:3003;
}
```

After Certbot succeeds, verify both the loopback readiness endpoint and the HTTPS site. If the Nginx site is already enabled, use `sudo nginx -t && sudo systemctl reload nginx` after any configuration change instead of creating a second symlink. Do not overwrite Certbot's installed HTTPS configuration with the initial HTTP-only template.

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
