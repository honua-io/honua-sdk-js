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
  lines.push(`- Certified surface: ${report.protocol.surface}`);
  lines.push(`- Target mode: \`${report.protocol.targetMode}\``);
  lines.push(`- MCP transport: \`${report.protocol.mcpTransport}\``);
  lines.push(
    `- Backend: \`${report.protocol.backend}\`${
      report.protocol.honuaTransport ? ` (Honua transport: \`${report.protocol.honuaTransport}\`)` : ""
    }`,
  );
  lines.push(
    `- Standard: \`${report.standard.source}\` (index ${report.standard.indexDate}, ${report.standard.dialect})`,
  );
  lines.push("");

  const p = report.provenance;
  lines.push("## Provenance");
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Target | ${p.targetUrl} |`);
  lines.push(`| Auth mode | \`${p.authMode}\` |`);
  lines.push(`| Negotiated protocol | \`${p.protocolVersion ?? "n/a"}\` |`);
  lines.push(`| Tools advertised | ${p.toolCount} |`);
  lines.push(`| Suite git SHA | \`${p.suiteGitSha}\` (${p.suiteGitShaSource}) |`);
  lines.push(`| Generated | \`${report.generatedAt}\` |`);
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
  lines.push(`| Tools with output-schema validated | ${s.toolsOutputValidated} |`);
  lines.push(`| Resources discovered | ${s.resourcesDiscovered} |`);
  lines.push(`| Prompts discovered | ${s.promptsDiscovered} |`);
  lines.push(`| Contracts checked | ${s.contractsPassed} / ${s.contractsChecked} passed |`);
  lines.push(`| Contracts skipped | ${s.contractsSkipped} |`);
  lines.push(`| Known gaps | ${s.knownGaps} |`);
  lines.push(`| Failures | ${s.failures} |`);
  lines.push("");

  lines.push("## Tools");
  lines.push("");
  lines.push("| Tool | Schema | Standard | Conformant | Read-only | Round-trip | Output schema |");
  lines.push("| --- | :---: | --- | :---: | :---: | :---: | :---: |");
  for (const t of report.tools) {
    const conformant = t.conformant === null ? "n/a" : t.conformant ? "yes" : "**NO**";
    const outputCol =
      t.structuredOutputValidated === true
        ? "validated"
        : t.structuredOutputValidated === false
          ? "**INVALID**"
          : t.hasOutputSchema
            ? "advertised"
            : "no";
    lines.push(
      `| \`${t.name}\` | ${t.schemaValid ? "valid" : "**invalid**"} | ${t.standardName ?? "—"} | ${conformant} | ${
        t.readOnly ? "yes" : "no"
      } | ${t.roundTrip} | ${outputCol} |`,
    );
  }
  lines.push("");

  lines.push("## Contracts");
  lines.push("");
  lines.push("| Contract | Target | Status | Detail |");
  lines.push("| --- | --- | :---: | --- |");
  for (const c of report.contracts) {
    const icon = c.status === "passed" ? "✅" : c.status === "failed" ? "❌" : "➖";
    lines.push(`| \`${c.contract}\` | \`${c.target}\` | ${icon} ${c.status} | ${c.detail} |`);
  }
  lines.push("");

  const toolErrors = report.tools.filter((t) => t.errors.length > 0);
  if (toolErrors.length > 0) {
    lines.push("### Tool failures");
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
      "These are standard capabilities not yet advertised as discrete tools, or advertised tools outside the standard. They are recorded, not failed.",
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
