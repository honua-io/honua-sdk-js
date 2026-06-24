import type { CertificationReport } from "./certifier.js";

/** Render a human-readable Markdown summary of a certification report. */
export function renderMarkdown(report: CertificationReport): string {
  const s = report.summary;
  const status = s.pass ? "✅ PASS" : "❌ FAIL";
  const lines: string[] = [];

  lines.push(`# MCP Certification — ${report.server.name} v${report.server.version}`);
  lines.push("");
  lines.push(`**Result:** ${status}`);
  lines.push("");
  lines.push(`- Generated: \`${report.generatedAt}\``);
  lines.push(`- MCP transport: \`${report.protocol.mcpTransport}\``);
  lines.push(
    `- Honua backend: \`${report.protocol.backend}\`${
      report.protocol.honuaTransport ? ` (transport: \`${report.protocol.honuaTransport}\`)` : ""
    }`,
  );
  lines.push(
    `- Standard: \`${report.standard.source}\` (index ${report.standard.indexDate}, ${report.standard.dialect})`,
  );
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | ---: |");
  lines.push(`| Tools discovered | ${s.toolsDiscovered} |`);
  lines.push(`| Tools with valid inputSchema | ${s.toolsSchemaValid} / ${s.toolsDiscovered} |`);
  lines.push(`| Tools conformance-checked | ${s.toolsConformanceChecked} |`);
  lines.push(`| Tools conformant | ${s.toolsConformant} / ${s.toolsConformanceChecked} |`);
  lines.push(`| Tools round-tripped | ${s.toolsRoundTripped} |`);
  lines.push(`| Resources discovered | ${s.resourcesDiscovered} |`);
  lines.push(`| Prompts discovered | ${s.promptsDiscovered} |`);
  lines.push(`| Known gaps | ${s.knownGaps} |`);
  lines.push(`| Failures | ${s.failures} |`);
  lines.push("");

  lines.push("## Tools");
  lines.push("");
  lines.push("| Tool | Schema | Standard | Conformant | Round-trip | Output schema |");
  lines.push("| --- | :---: | --- | :---: | :---: | :---: |");
  for (const t of report.tools) {
    const conformant = t.conformant === null ? "n/a" : t.conformant ? "yes" : "**NO**";
    lines.push(
      `| \`${t.name}\` | ${t.schemaValid ? "valid" : "**invalid**"} | ${t.standardName ?? "—"} | ${conformant} | ${t.roundTrip} | ${t.hasOutputSchema ? "yes" : "no"} |`,
    );
  }
  lines.push("");

  const toolErrors = report.tools.filter((t) => t.errors.length > 0);
  if (toolErrors.length > 0) {
    lines.push("### Failures");
    lines.push("");
    for (const t of toolErrors) {
      lines.push(`- \`${t.name}\``);
      for (const e of t.errors) {
        lines.push(`  - ${e}`);
      }
    }
    lines.push("");
  }

  if (report.resources.length > 0) {
    lines.push("## Resources");
    lines.push("");
    for (const r of report.resources) {
      lines.push(`- \`${r.name}\` — \`${r.uri}\``);
    }
    lines.push("");
  }

  if (report.knownGaps.length > 0) {
    lines.push("## Known gaps");
    lines.push("");
    lines.push(
      "These are standard capabilities not yet implemented as discrete tools, or advertised tools outside the standard. They are recorded, not failed.",
    );
    lines.push("");
    for (const g of report.knownGaps) {
      const family = g.family ? ` _(${g.family})_` : "";
      lines.push(`- **${g.kind}** \`${g.name}\`${family} — ${g.detail}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
