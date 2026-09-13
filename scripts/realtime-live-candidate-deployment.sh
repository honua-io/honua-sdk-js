#!/usr/bin/env bash
# Isolated deployment of the exact candidate honua-server image for the realtime
# live authorization receipt (#1692, honua-server#3871).
#
#   up    PostGIS + Redis + the candidate image, the candidate revision's own
#         tests/seed/client-compat-v1.sql applied to the server-migrated database,
#         two protected tenants (test/fixtures/realtime/live-authorization-tenants.sql),
#         and a static-key OIDC issuer whose JWTs generateToken relays into
#         revocable, short-lived portal tokens. Writes a deployment descriptor.
#   logs  Prints the candidate container log.
#   down  Removes the containers and network.
#
# The image runs as ASPNETCORE_ENVIRONMENT=Staging with the image's own
# appsettings.Production.json mounted as its environment file: Production refuses
# the Licensing:DevGrantEdition override, and realtime streams need the Pro
# entitlement that CI cannot hold a signed licence for. Every other setting is
# the image's production configuration. The Metadata v2 environment stays
# Production so the seeded graph is the one served.
set -euo pipefail

command="${1:-up}"
network="${HONUA_REALTIME_CANDIDATE_NETWORK:-honua-realtime-candidate}"
port="${HONUA_REALTIME_CANDIDATE_PORT:-18080}"
pg_container="${network}-pg"
redis_container="${network}-redis"
server_container="${network}-server"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Holds the env file and the bind-mounted settings file for the life of the
# deployment, so a container restart still finds them; `down` removes it.
work="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/${network}-work"

teardown() {
  docker rm -f "$server_container" "$redis_container" "$pg_container" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf "$work"
}

case "$command" in
  logs)
    docker logs "$server_container" 2>&1 || true
    exit 0
    ;;
  down)
    teardown
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: $0 up|logs|down" >&2
    exit 2
    ;;
esac

: "${HONUA_REALTIME_CANDIDATE_IMAGE:?set to ghcr.io/honua-io/honua-server@sha256:<digest>}"
: "${HONUA_REALTIME_CANDIDATE_REVISION:?set to the candidate 40-character commit SHA}"
: "${HONUA_REALTIME_CANDIDATE_ADMIN_API_KEY:?set to a per-run admin password}"
: "${HONUA_REALTIME_ISSUER:?set to the test issuer identifier}"
: "${HONUA_REALTIME_ISSUER_AUDIENCE:?set to the test issuer audience}"
: "${HONUA_REALTIME_ISSUER_SIGNING_KEY:?set to a per-run HS256 signing key}"
: "${HONUA_REALTIME_CANDIDATE_DESCRIPTOR:?set to the deployment descriptor output path}"

if ! [[ "$HONUA_REALTIME_CANDIDATE_IMAGE" =~ ^[^[:space:]@]+@(sha256:[0-9a-f]{64})$ ]]; then
  echo "HONUA_REALTIME_CANDIDATE_IMAGE must be pinned by digest (image@sha256:...)" >&2
  exit 1
fi
digest="${BASH_REMATCH[1]}"
if ! [[ "$HONUA_REALTIME_CANDIDATE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "HONUA_REALTIME_CANDIDATE_REVISION must be a 40-character commit SHA" >&2
  exit 1
fi
if [ "${#HONUA_REALTIME_ISSUER_SIGNING_KEY}" -lt 32 ]; then
  echo "HONUA_REALTIME_ISSUER_SIGNING_KEY must be at least 32 characters" >&2
  exit 1
fi

pg_password="$(openssl rand -hex 16)"
image="$HONUA_REALTIME_CANDIDATE_IMAGE"

wait_ready() {
  for _ in $(seq 1 60); do
    if [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${port}/healthz/ready")" = "200" ]; then
      return 0
    fi
    if [ "$(docker inspect -f '{{.State.Running}}' "$server_container" 2>/dev/null)" != "true" ]; then
      echo "the candidate container exited before becoming ready" >&2
      docker logs "$server_container" 2>&1 | tail -40 >&2 || true
      return 1
    fi
    sleep 3
  done
  echo "the candidate did not become ready" >&2
  docker logs "$server_container" 2>&1 | tail -40 >&2 || true
  return 1
}

psql_candidate() {
  docker exec -i "$pg_container" psql -q -v ON_ERROR_STOP=1 -U postgres -d honua "$@"
}

docker pull -q "$image" >/dev/null
image_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
if [ "$image_revision" != "$HONUA_REALTIME_CANDIDATE_REVISION" ]; then
  echo "image revision label '${image_revision}' does not match the candidate ${HONUA_REALTIME_CANDIDATE_REVISION}" >&2
  exit 1
fi

teardown
mkdir -p "$work"
chmod 700 "$work"
docker network create "$network" >/dev/null
docker run -d --name "$pg_container" --network "$network" \
  -e POSTGRES_DB=honua -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$pg_password" \
  -e POSTGIS_GDAL_ENABLED_DRIVERS=ENABLE_ALL \
  postgis/postgis:16-3.4 >/dev/null
docker run -d --name "$redis_container" --network "$network" redis:7.4-alpine redis-server --appendonly no >/dev/null
# pg_isready also answers during the image's temporary init server, while its
# own init script is still creating the PostGIS extension; wait for the real start.
for attempt in $(seq 1 40); do
  if [ "$(docker logs "$pg_container" 2>&1 | grep -c "PostgreSQL init process complete")" -gt 0 ] &&
    docker exec "$pg_container" pg_isready -U postgres -d honua >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 40 ]; then
    echo "PostGIS did not become ready" >&2
    exit 1
  fi
  sleep 2
done
# The raster extension must exist before the first migration run, or the
# migration-owned raster tables are created later without their storage settings.
psql_candidate -c "CREATE EXTENSION IF NOT EXISTS postgis" -c "CREATE EXTENSION IF NOT EXISTS postgis_raster"

extract="$(docker create "$image")"
docker cp "${extract}:/app/appsettings.Production.json" "$work/appsettings.Production.json"
docker rm "$extract" >/dev/null
chmod 644 "$work/appsettings.Production.json"

cat > "$work/candidate.env" <<EOF
ASPNETCORE_ENVIRONMENT=Staging
ASPNETCORE_URLS=http://+:8080
PUBLIC_BASE_URL=http://127.0.0.1:${port}
HONUA_ADMIN_PASSWORD=${HONUA_REALTIME_CANDIDATE_ADMIN_API_KEY}
ConnectionStrings__DefaultConnection=Server=${pg_container};Port=5432;Database=honua;User Id=postgres;Password=${pg_password};
ConnectionStrings__honua=Server=${pg_container};Port=5432;Database=honua;User Id=postgres;Password=${pg_password};
ConnectionStrings__Redis=${redis_container}:6379
Security__ConnectionEncryption__MasterKey=$(openssl rand -hex 32)
Security__ConnectionEncryption__Salt=$(openssl rand -base64 32)
HostValidation__AllowedHosts__0=localhost
HostValidation__AllowedHosts__1=127.0.0.1
Metadata__Environment=Production
Licensing__DevGrantEdition=Pro
Capabilities__Experimental__Enabled=true
MultiTenancy__MultiTenantAdminRoles__0=admin
Authentication__PortalToken__RequireHttps=false
Authentication__PortalCredentialVerifier__UseOidc=true
Oidc__Enabled=true
Oidc__RequireHttps=true
Oidc__Generic__Enabled=true
Oidc__Generic__Authority=${HONUA_REALTIME_ISSUER}
Oidc__Generic__ClientId=${HONUA_REALTIME_ISSUER_AUDIENCE}
Oidc__Generic__ClientSecret=unused-static-key-issuer
Oidc__TokenValidation__SymmetricSigningKey=${HONUA_REALTIME_ISSUER_SIGNING_KEY}
Oidc__TokenValidation__ValidIssuers__0=${HONUA_REALTIME_ISSUER}
Oidc__TokenValidation__ValidAudiences__0=${HONUA_REALTIME_ISSUER_AUDIENCE}
Oidc__TokenValidation__ClockSkew=00:00:00
EOF
chmod 600 "$work/candidate.env"

start_candidate() {
  for boot in 1 2 3; do
    docker rm -f "$server_container" >/dev/null 2>&1 || true
    docker run -d --name "$server_container" --network "$network" -p "127.0.0.1:${port}:8080" \
      --env-file "$work/candidate.env" \
      -v "$work/appsettings.Production.json:/app/appsettings.Staging.json:ro" \
      "$image" >/dev/null
    if wait_ready; then
      return 0
    fi
    # Startup validation resolves outbound provider hosts. Only a resolver that is
    # momentarily unavailable is retried; every other startup failure is final.
    if [ "$(docker logs "$server_container" 2>&1 | grep -c "host name resolution is currently unavailable")" -eq 0 ] ||
      [ "$boot" -eq 3 ]; then
      return 1
    fi
    echo "candidate boot ${boot}: host name resolution was unavailable; resolver check from the deployment network:" >&2
    docker exec "$redis_container" nslookup nominatim.openstreetmap.org >&2 || true
    sleep 10
  done
}

# First boot runs the candidate's own migrations on the empty database.
start_candidate
seed="$work/client-compat-v1.sql"
curl -fsSL --retry 5 --retry-all-errors \
  "https://raw.githubusercontent.com/honua-io/honua-server/${HONUA_REALTIME_CANDIDATE_REVISION}/tests/seed/client-compat-v1.sql" \
  -o "$seed"
psql_candidate < "$seed" >/dev/null
overlay="$repo_root/test/fixtures/realtime/live-authorization-tenants.sql"
psql_candidate < "$overlay"
# Restart so the cached Metadata v2 graph is the seeded, tenant-scoped one.
start_candidate

capabilities="$(curl -fsS -m 10 "http://127.0.0.1:${port}/api/v1/streaming/features/capabilities")"
observed_revision="$(node -e 'const d=JSON.parse(process.argv[1]).data; process.stdout.write(String(d?.deploymentRevision ?? ""))' "$capabilities")"
if [ "$observed_revision" != "$HONUA_REALTIME_CANDIDATE_REVISION" ]; then
  echo "the deployment reports revision '${observed_revision}', not the candidate" >&2
  exit 1
fi

sha() { sha256sum "$1" | cut -d' ' -f1; }
mkdir -p "$(dirname "$HONUA_REALTIME_CANDIDATE_DESCRIPTOR")"
node - "$HONUA_REALTIME_CANDIDATE_DESCRIPTOR" <<EOF
const crypto = require("node:crypto");
const fs = require("node:fs");
const secret = /(PASSWORD|MasterKey|Salt|SigningKey|ClientSecret|ConnectionStrings)/i;
const configuration = fs.readFileSync("$work/candidate.env", "utf8").trim().split("\n")
  .map((line) => line.split("=")).map(([key, ...rest]) => [key, secret.test(key) ? "<per-run secret>" : rest.join("=")]);
const descriptor = {
  image: "$image",
  digest: "$digest",
  revision: "$HONUA_REALTIME_CANDIDATE_REVISION",
  imageRevisionLabel: "$image_revision",
  observedRevision: "$observed_revision",
  aspnetcoreEnvironment: "Staging",
  environmentSettingsFile: { source: "/app/appsettings.Production.json", sha256: "$(sha "$work/appsettings.Production.json")" },
  seed: { source: "honua-server@$HONUA_REALTIME_CANDIDATE_REVISION:tests/seed/client-compat-v1.sql", sha256: "$(sha "$seed")" },
  tenantOverlay: { source: "test/fixtures/realtime/live-authorization-tenants.sql", sha256: "$(sha "$overlay")" },
  dependencies: { postgis: "postgis/postgis:16-3.4", redis: "redis:7.4-alpine" },
  configuration: Object.fromEntries(configuration),
};
descriptor.fingerprint = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
fs.writeFileSync(process.argv[2], JSON.stringify(descriptor, null, 2) + "\n");
process.stdout.write(descriptor.fingerprint + "\n");
EOF
