/** Read production claims from the split-build table, excluding external dependencies. */
export function documentedSplitPackages(markdown) {
  const section = markdown.match(/^## Packages produced by the split build\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
  if (!section) throw new Error("Split-package documentation must contain the produced-packages section");
  const rows = section.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("|"));
  if (!rows[0]?.match(/^\|\s*Package\s*\|/)) throw new Error("Split-package documentation must contain the production table header");
  if (!rows[1]?.match(/^\|\s*:?-+:?\s*\|/)) throw new Error("Split-package documentation must contain the production table separator");
  const packages = rows.slice(2).map((row) => {
    const name = row.match(/^\|\s*`(@honua\/[a-z0-9-]+)`\s*\|.*\|$/)?.[1];
    if (!name) throw new Error(`Malformed produced-package table row: ${row}`);
    return name;
  });
  if (packages.length === 0) throw new Error("Split-package documentation must list produced packages in its table");
  if (new Set(packages).size !== packages.length) throw new Error("Split-package documentation repeats a produced package");
  return new Set(packages);
}
