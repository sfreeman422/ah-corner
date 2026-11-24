#!/usr/bin/env bash
# Provisions AH Corner on the existing MySQL service at muzzle.lol.
# Run this interactively as the muzzle.lol user; it prompts for sudo locally.
set -euo pipefail

if [[ $- == *x* ]]; then
  echo "Do not run this script with shell tracing enabled; it handles generated credentials." >&2
  exit 2
fi
if [[ $(id -u) -eq 0 ]]; then
  echo "Run this script as your regular server user, without sudo; it will prompt for sudo when needed." >&2
  exit 2
fi

project_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
database_name="${AH_CORNER_DATABASE:-ahcorner}"
runtime_user="ah_corner_runtime"
migration_user="ah_corner_migrate"

if [[ ! "$database_name" =~ ^[A-Za-z0-9_]{1,64}$ ]]; then
  echo "AH_CORNER_DATABASE must contain only letters, digits, and underscores." >&2
  exit 2
fi

cd "$project_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
fi
chmod 600 .env

if [[ "${AH_CORNER_RECONFIGURE:-}" != "true" ]] && { grep -q '^DATABASE_URL=.' .env || grep -q '^DATABASE_MIGRATION_URL=.' .env; }; then
  echo "Database URLs are already configured. Refusing to replace them." >&2
  echo "Set AH_CORNER_RECONFIGURE=true only if you intend to rotate AH Corner's database credentials." >&2
  exit 1
fi

if ! command -v openssl >/dev/null; then
  echo "openssl is required to generate database passwords." >&2
  exit 1
fi

# Create the Compose network first, then restrict MySQL accounts to its actual
# /16 source range. The database destination remains host.docker.internal.
docker compose build app
docker compose create app >/dev/null
subnet="$(docker network inspect ah-corner_default --format '{{(index .IPAM.Config 0).Subnet}}')"
if [[ ! "$subnet" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.0\.0/16$ ]]; then
  echo "Expected ah-corner_default to use an IPv4 /16 network; got: $subnet" >&2
  exit 1
fi
docker_host_pattern="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.%"

echo "This creates the isolated $database_name schema and AH Corner-only MySQL users."
echo "The MySQL users will accept connections only from Docker range $docker_host_pattern."
sudo -v

# This host's MySQL root account can require a password even when the OS user
# has sudo. Prompt on the terminal; never pass the password in an argument.
mysql_auth_args=(--user=root --password)
if [[ "${AH_CORNER_MYSQL_AUTH:-password}" == "socket" ]]; then
  mysql_auth_args=(--user=root)
elif [[ "${AH_CORNER_MYSQL_AUTH:-password}" != "password" ]]; then
  echo "AH_CORNER_MYSQL_AUTH must be password or socket." >&2
  exit 2
fi
if [[ "${AH_CORNER_MYSQL_AUTH:-password}" == "password" ]]; then
  echo "MySQL will prompt for its root password (which may differ from your sudo password)."
fi

# Hex supplies entropy; the suffix also satisfies MySQL's common mixed-case,
# digit, and special-character policy. All characters are safe in the URL,
# dotenv file, and the SQL string below.
runtime_password="$(openssl rand -hex 32)Aa1!"
migration_password="$(openssl rand -hex 32)Aa1!"

# Supply SQL on stdin rather than as command-line arguments, keeping generated
# passwords out of process listings. Values are constrained/generated above.
sudo mysql "${mysql_auth_args[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS \`$database_name\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS '$runtime_user'@'$docker_host_pattern' IDENTIFIED BY '$runtime_password';
CREATE USER IF NOT EXISTS '$migration_user'@'$docker_host_pattern' IDENTIFIED BY '$migration_password';
ALTER USER '$runtime_user'@'$docker_host_pattern' IDENTIFIED BY '$runtime_password';
ALTER USER '$migration_user'@'$docker_host_pattern' IDENTIFIED BY '$migration_password';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`$database_name\`.* TO '$runtime_user'@'$docker_host_pattern';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX ON \`$database_name\`.* TO '$migration_user'@'$docker_host_pattern';
FLUSH PRIVILEGES;
SQL

runtime_url="mysql://$runtime_user:$runtime_password@host.docker.internal:3306/$database_name"
migration_url="mysql://$migration_user:$migration_password@host.docker.internal:3306/$database_name"
temp_env="$(mktemp .env.XXXXXX)"
cleanup(){ rm -f "$temp_env"; }
trap cleanup EXIT
chmod 600 "$temp_env"
awk '
  /^DATABASE_URL=/ || /^DATABASE_MIGRATION_URL=/ || /^DATABASE_SSL=/ || /^REQUIRE_DATABASE_SSL=/ ||
  /^BIND_ADDRESS=/ || /^HOST_PORT=/ || /^APP_TRUSTED_HOSTS=/ || /^APP_TRUSTED_ORIGINS=/ { next }
  { print }
' .env > "$temp_env"
printf '%s\n' \
  "DATABASE_URL=$runtime_url" \
  "DATABASE_MIGRATION_URL=$migration_url" \
  'DATABASE_SSL=disable' \
  'REQUIRE_DATABASE_SSL=false' \
  'BIND_ADDRESS=127.0.0.1' \
  'HOST_PORT=3003' \
  'APP_TRUSTED_HOSTS=ah.muzzle.lol' \
  'APP_TRUSTED_ORIGINS=https://ah.muzzle.lol' >> "$temp_env"
mv "$temp_env" .env
chmod 600 .env
trap - EXIT

echo "Running the migration and starting AH Corner."
docker compose run --rm app npm run migrate
docker compose up -d --force-recreate app

for _ in {1..20}; do
  if curl -fsS -H 'Host: ah.muzzle.lol' http://127.0.0.1:3003/readyz; then
    echo
    echo "AH Corner is ready at https://ah.muzzle.lol."
    exit 0
  fi
  sleep 1
done

echo "The container did not become ready. Recent logs:" >&2
docker compose logs --tail=100 app >&2
exit 1
