#!/usr/bin/env bash
# Isolated deployment of the exact candidate honua-server image for the portable
# map artifact lifecycle receipt (#1426).
#
#   up    PostGIS + Redis + the candidate image in its own Production
#         environment, a per-run key-ring certificate, and a static-key OIDC
#         issuer whose HS256 JWTs carry tenant, role and OAuth-scope claims for
#         distinct author, approver and cross-tenant principals. Writes a redacted
#         deployment descriptor.
#   logs  Prints the candidate container log.
#   down  Removes the containers, network and per-run work directory.
#
# Two settings differ from the image's shipped defaults, and the descriptor
# records both:
#   - Licensing:Mode=Disabled, the 2026.1 licensing ruling (licensing ships
#     disabled), so no signed licence is needed.
#   - Oidc:TokenValidation:EnableTokenReplayProtection=false. With the default
#     (true) every bearer JWT is single-use (keyed by jti, else by a hash of the
#     whole token), while an MCP session is bound to the exact credential that
#     opened it, so no bearer MCP session can make a second request. The receipt
#     records that behaviour as a candidate finding instead of hiding it.
set -euo pipefail

command="${1:-up}"
network="${HONUA_MAP_CANDIDATE_NETWORK:-honua-map-artifact-candidate}"
port="${HONUA_MAP_CANDIDATE_PORT:-18426}"
pg_container="${network}-pg"
redis_container="${network}-redis"
server_container="${network}-server"
# Holds the env file and the key ring for the life of the deployment, so a
# container restart still finds them; `down` removes it.
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

: "${HONUA_MAP_CANDIDATE_IMAGE:?set to ghcr.io/honua-io/honua-server@sha256:<digest>}"
: "${HONUA_MAP_CANDIDATE_REVISION:?set to the candidate 40-character commit SHA}"
: "${HONUA_MAP_ISSUER_SIGNING_KEY_FILE:?set to a file holding a per-run HS256 signing key}"
: "${HONUA_MAP_CANDIDATE_DESCRIPTOR:?set to the deployment descriptor output path}"
issuer="${HONUA_MAP_ISSUER:-https://map-artifact.honua.test}"
audience="${HONUA_MAP_ISSUER_AUDIENCE:-honua-map-artifact}"

if ! [[ "$HONUA_MAP_CANDIDATE_IMAGE" =~ ^[^[:space:]@]+@(sha256:[0-9a-f]{64})$ ]]; then
  echo "HONUA_MAP_CANDIDATE_IMAGE must be pinned by digest (image@sha256:...)" >&2
  exit 1
fi
digest="${BASH_REMATCH[1]}"
if ! [[ "$HONUA_MAP_CANDIDATE_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "HONUA_MAP_CANDIDATE_REVISION must be a 40-character commit SHA" >&2
  exit 1
fi
signing_key="$(tr -d '\r\n' < "$HONUA_MAP_ISSUER_SIGNING_KEY_FILE")"
if [ "${#signing_key}" -lt 32 ]; then
  echo "the issuer signing key must be at least 32 characters" >&2
  exit 1
fi

image="$HONUA_MAP_CANDIDATE_IMAGE"
pg_password="$(openssl rand -hex 16)"
# Production validates the bootstrap admin password's character classes.
admin_password="Aa1!$(openssl rand -hex 16)"

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

docker pull -q "$image" >/dev/null
image_revision="$(docker image inspect -f '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")"
if [ "$image_revision" != "$HONUA_MAP_CANDIDATE_REVISION" ]; then
  echo "image revision label '${image_revision}' does not match the candidate ${HONUA_MAP_CANDIDATE_REVISION}" >&2
  exit 1
fi

teardown
mkdir -p "$work"
chmod 700 "$work"
docker network create "$network" >/dev/null

docker run -d --name "$pg_container" --network "$network" \
  -e POSTGRES_DB=honua -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$pg_password" \
  postgis/postgis:16-3.4 >/dev/null
docker run -d --name "$redis_container" --network "$network" redis:7.4-alpine redis-server --appendonly no >/dev/null

# The postgis image restarts once after init; pg_isready alone can pass during
# that restart, so wait for the init-complete marker first.
for _ in $(seq 1 60); do
  if docker logs "$pg_container" 2>&1 | grep -q "PostgreSQL init process complete" &&
    docker exec "$pg_container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
# Both extensions must exist before first boot or the schema floor refuses to start.
docker exec -i "$pg_container" psql -q -v ON_ERROR_STOP=1 -U postgres -d honua \
  -c "CREATE EXTENSION IF NOT EXISTS postgis" -c "CREATE EXTENSION IF NOT EXISTS postgis_raster"

# Every image since honua-server#4722 requires a key-ring certificate in
# Production with Redis; a throwaway self-signed PKCS#12 is enough.
keyring_password="$(openssl rand -hex 16)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=${network}-keyring" \
  -keyout "$work/keyring.key" -out "$work/keyring.crt" 2>/dev/null
openssl pkcs12 -export -inkey "$work/keyring.key" -in "$work/keyring.crt" \
  -out "$work/keyring.p12" -passout "pass:${keyring_password}"
rm -f "$work/keyring.key" "$work/keyring.crt"
# Bind-mounted read-only; the container's non-root user reads it by mode.
chmod 644 "$work/keyring.p12"

cat > "$work/candidate.env" <<EOF
ASPNETCORE_ENVIRONMENT=Production
ASPNETCORE_URLS=http://+:8080
PUBLIC_BASE_URL=http://127.0.0.1:${port}
HONUA_ADMIN_PASSWORD=${admin_password}
ConnectionStrings__DefaultConnection=Server=${pg_container};Port=5432;Database=honua;User Id=postgres;Password=${pg_password};
ConnectionStrings__honua=Server=${pg_container};Port=5432;Database=honua;User Id=postgres;Password=${pg_password};
ConnectionStrings__Redis=${redis_container}:6379
Security__ConnectionEncryption__MasterKey=$(openssl rand -hex 32)
Security__ConnectionEncryption__Salt=$(openssl rand -base64 32)
HostValidation__AllowedHosts__0=localhost
HostValidation__AllowedHosts__1=127.0.0.1
Licensing__Mode=Disabled
Oidc__Enabled=true
Oidc__RequireHttps=true
Oidc__AdminRoles__0=admin
Oidc__Generic__Enabled=true
Oidc__Generic__Authority=${issuer}
Oidc__Generic__ClientId=${audience}
Oidc__Generic__ClientSecret=unused-static-key-issuer
Oidc__TokenValidation__SymmetricSigningKey=${signing_key}
Oidc__TokenValidation__ValidIssuers__0=${issuer}
Oidc__TokenValidation__ValidAudiences__0=${audience}
Oidc__TokenValidation__ClockSkew=00:00:00
Oidc__TokenValidation__EnableTokenReplayProtection=false
Operations__SecretChannel__KeyRingCertificatePath=/app/keyring.p12
Operations__SecretChannel__KeyRingCertificatePassword=${keyring_password}
EOF
chmod 600 "$work/candidate.env"
# The installed CLI authenticates only with an API key; the receipt reads the
# bootstrap admin key from this 0600 file, never from the descriptor.
printf '%s' "$admin_password" > "$work/admin-key"
chmod 600 "$work/admin-key"

docker run -d --name "$server_container" --network "$network" -p "127.0.0.1:${port}:8080" \
  --env-file "$work/candidate.env" \
  -v "$work/keyring.p12:/app/keyring.p12:ro" \
  "$image" >/dev/null
wait_ready

mkdir -p "$(dirname "$HONUA_MAP_CANDIDATE_DESCRIPTOR")"
node - "$HONUA_MAP_CANDIDATE_DESCRIPTOR" "$work/candidate.env" <<EOF
const crypto = require("node:crypto");
const fs = require("node:fs");
const secret = /(PASSWORD|MasterKey|Salt|SigningKey|ClientSecret|ConnectionStrings)/i;
const configuration = fs.readFileSync(process.argv[3], "utf8").trim().split("\n")
  .map((line) => line.split("=")).map(([key, ...rest]) => [key, secret.test(key) ? "<per-run secret>" : rest.join("=")]);
const descriptor = {
  image: "$image",
  digest: "$digest",
  revision: "$HONUA_MAP_CANDIDATE_REVISION",
  imageRevisionLabel: "$image_revision",
  aspnetcoreEnvironment: "Production",
  baseUrl: "http://127.0.0.1:${port}",
  issuer: "$issuer",
  audience: "$audience",
  adminKeyFile: "$work/admin-key",
  dependencies: { postgis: "postgis/postgis:16-3.4", redis: "redis:7.4-alpine" },
  defaultsChanged: {
    "Licensing__Mode": "2026.1 ships licensing disabled",
    "Oidc__TokenValidation__EnableTokenReplayProtection": "default true makes every bearer JWT single-use; a bearer MCP session cannot make a second request",
  },
  configuration: Object.fromEntries(configuration),
};
descriptor.fingerprint = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
fs.writeFileSync(process.argv[2], JSON.stringify(descriptor, null, 2) + "\n");
process.stdout.write(descriptor.fingerprint + "\n");
EOF
