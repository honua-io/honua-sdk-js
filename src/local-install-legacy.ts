/** Reconstruct the pre-2026.1 Redis-bearing compose template from a zero-Redis template for safe upgrades. */
export function withLegacyRedisCompose(compose: string): string {
  return compose
    .replace(
      '    restart: "no"\n  honua:\n',
      '    restart: "no"\n' +
        "  redis:\n" +
        "    image: redis:7.4-alpine\n" +
        '    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "64mb", "--maxmemory-policy", "noeviction"]\n' +
        "    volumes:\n" +
        "      - redis_data:/data\n" +
        "    healthcheck:\n" +
        '      test: ["CMD", "redis-cli", "ping"]\n' +
        "      interval: 5s\n" +
        "      timeout: 3s\n" +
        "      retries: 20\n" +
        "    restart: unless-stopped\n" +
        "  honua:\n",
    )
    .replace(
      "      HONUA_ADMIN_PASSWORD: ${HONUA_ADMIN_PASSWORD}\n",
      "      ConnectionStrings__Redis: redis:6379\n      HONUA_ADMIN_PASSWORD: ${HONUA_ADMIN_PASSWORD}\n",
    )
    .replace(
      "      postgis-bootstrap:\n        condition: service_completed_successfully\n    volumes:\n",
      "      postgis-bootstrap:\n        condition: service_completed_successfully\n      redis:\n        condition: service_healthy\n    volumes:\n",
    )
    .replace(
      "volumes:\n  postgres_data:\n  honua_storage:\n",
      "volumes:\n  postgres_data:\n  redis_data:\n  honua_storage:\n",
    );
}
