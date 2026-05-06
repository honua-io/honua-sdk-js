import { describe, expect, it } from "vitest";

import {
  answerWithFixtures,
  applyFilters,
  boundedSummary,
  createMcpGisAssistantSession,
} from "../examples/mcp-gis-assistant/src/assistant.js";
import {
  ASSISTANT_RESULT_LIMIT,
  createFixtureMcpGisAssistantDataset,
} from "../examples/mcp-gis-assistant/src/fixtures.js";

describe("MCP GIS Assistant sample", () => {
  it("grounds discovery answers in fixture services, layers, schema, and diagnostics", () => {
    const dataset = createFixtureMcpGisAssistantDataset();
    const turn = answerWithFixtures(dataset, "List services, layers, and schema", 1);

    expect(turn.assistantText).toContain("Honolulu Operations");
    expect(turn.assistantText).toContain("5 fields");
    expect(turn.toolCalls.map((call) => call.name)).toEqual(["list_services", "describe_layer"]);
    expect(JSON.stringify(turn.toolCalls[1]?.result)).toContain("statistics");
    expect(turn.diagnostics.map((diagnostic) => diagnostic.code)).toContain("missing-cloud-credentials");
  });

  it("stages generated filters for review before mutating the visible projection", () => {
    const session = createMcpGisAssistantSession(createFixtureMcpGisAssistantDataset());

    const initialRows = applyFilters(session.dataset.features, session.currentProjection().filters);
    const turn = session.ask("Find open critical tasks");
    const stagedDraft = session.workspace.state.drafts.entries["draft-generated-filter"];

    expect(initialRows).toHaveLength(6);
    expect(turn.draft?.where).toBe("status = 'open' AND priority = 'critical'");
    expect(stagedDraft?.description).toBe(turn.draft?.where);
    expect(applyFilters(session.dataset.features, session.currentProjection().filters)).toHaveLength(6);

    const projection = session.applyDraft("draft-generated-filter");

    expect(projection?.filters.status?.value).toBe("open");
    expect(projection?.filters.priority?.value).toBe("critical");
    expect(
      applyFilters(session.dataset.features, session.currentProjection().filters).map((feature) => feature.id),
    ).toEqual(["1001", "1004"]);
    expect(session.workspace.state.drafts.entries).toEqual({});

    session.dispose();
  });

  it("keeps feature query summaries bounded and reports unsupported capability states", () => {
    const dataset = createFixtureMcpGisAssistantDataset();
    const summary = boundedSummary(dataset.features, ASSISTANT_RESULT_LIMIT);
    const capabilityTurn = answerWithFixtures(dataset, "Show unsupported capabilities", 3);

    expect(summary).toMatchObject({
      totalMatched: 6,
      returned: 3,
      limit: 3,
      truncated: true,
    });
    expect(capabilityTurn.assistantText).toContain("Realtime is unsupported");
    expect(capabilityTurn.toolCalls[0]?.name).toBe("describe_layer");
  });
});
