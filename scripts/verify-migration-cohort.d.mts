export function migratorCompatPackageName(lock: {
  packages?: Record<string, { dependencies?: Record<string, string> } | undefined>;
}): string;
