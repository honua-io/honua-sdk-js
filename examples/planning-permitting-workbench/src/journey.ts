import {
  type CanonicalFeature,
  type EditWorkflowField,
  type EditWorkflowStatus,
  type EditWorkflowSubmitResult,
  type Source,
  createEditSession,
} from "@honua/sdk-js/contract";
import { type GeocodeResult, HonuaGeocodingClient } from "@honua/sdk-js/geocoding";
import {
  type GeoJsonPolygon,
  area,
  bbox,
  booleanIntersects,
  centroid,
  intersect,
  length,
} from "@honua/sdk-js/geometry";
import {
  type ConnectionInspection,
  type HonuaFieldInfo,
  type HonuaKernel,
  type HonuaKernelConnection,
  createHonua,
  envelope,
} from "@honua/sdk-js/honua";

export const PLANNING_FIXTURE_VERSION = "planning-permitting.v1";
export const PLANNING_GENERATED_AT = "2026-07-16T12:00:00.000Z";
export const PLANNING_SERVICE_PATH = "/rest/services/Maui/Planning/FeatureServer";
export const PLANNING_WRITABLE_LAYER = 0;
export const PLANNING_READONLY_LAYER = 1;
export const PLANNING_CANDIDATE_LIMIT = 25;
/** Upper bound on the fixture-backed application list the editor selects from. */
export const PLANNING_APPLICATION_LIMIT = 25;

/** A planning application as the editor consumes it: contract-canonical, id-bearing. */
export type PlanningApplication = CanonicalFeature<PlanningRecordAttributes>;

export type PlanningScenario = "success" | "invalid-domain" | "conflict" | "attachment-failure" | "unsupported";

export interface PlanningRecordAttributes extends Record<string, unknown> {
  OBJECTID?: number;
  permit_no: string;
  parcel_tmk: string;
  address: string;
  zoning: string;
  flood_zone: string;
  permit_type: string;
  status: string;
  description: string;
  proposed_height_ft: number;
  version?: number;
  last_edited_date?: string;
}

export interface PlanningSearchResult {
  readonly address: string;
  readonly geocode: GeocodeResult;
  readonly featureId: number;
  readonly attributes: PlanningRecordAttributes;
  readonly cacheStatus: ConnectionInspection["cacheStatus"];
  readonly sourceId: string;
  readonly protocol: string;
}

export interface PlanningAnalysisStep {
  readonly id: "candidate-query" | "client-geometry" | "hazard-intersection";
  readonly execution: "source" | "client";
  readonly detail: string;
}

export interface PlanningAnalysisResult {
  readonly proposalAreaSquareMeters: number;
  readonly proposalPerimeterMeters: number;
  readonly hazardOverlapSquareMeters: number;
  readonly intersectsFloodHazard: boolean;
  readonly boundedCandidateCount: number;
  readonly candidateLimit: number;
  readonly plan: readonly PlanningAnalysisStep[];
  readonly provenance: {
    readonly fixtureVersion: string;
    readonly metadataSources: readonly string[];
    readonly sourceId: string;
    readonly protocol: string;
  };
  readonly fidelity: {
    readonly status: "exact-client-geometry";
    readonly crs: "EPSG:4326";
    readonly caveat: string;
  };
}

export interface PlanningDraft {
  readonly values: PlanningRecordAttributes;
  readonly geometry: { readonly x: number; readonly y: number; readonly spatialReference: { readonly wkid: 4326 } };
}

export interface PlanningSubmissionResult {
  readonly scenario: PlanningScenario;
  readonly status: EditWorkflowStatus;
  readonly result: EditWorkflowSubmitResult<PlanningRecordAttributes>;
  readonly optimisticTransitions: readonly ("applied" | "committed" | "rolled-back")[];
  readonly recoverable: boolean;
  readonly recovery: string;
}

export interface PlanningReviewModel {
  readonly kind: "honua.planning-permitting-review";
  readonly version: 1;
  readonly generatedAt: string;
  readonly fixtureVersion: string;
  readonly semantic: {
    readonly workflow: "search-analyze-edit-export";
    readonly publicSurfaces: readonly ["source-query", "geocoding", "geometry", "edit-session", "attachments"];
    readonly failureScenarios: readonly ["invalid-domain", "conflict", "attachment-failure", "unsupported"];
  };
  readonly search: PlanningSearchResult;
  readonly analysis: PlanningAnalysisResult;
  readonly submissions: readonly PlanningSubmissionResult[];
}

export interface CreatePlanningJourneyOptions {
  /** Origin hosting both the deterministic fixture API and the sample assets. */
  readonly baseUrl: string;
  readonly fetchFn?: typeof fetch;
}

const REQUIRED_EDIT_FIELDS = [
  "OBJECTID",
  "permit_no",
  "parcel_tmk",
  "address",
  "zoning",
  "flood_zone",
  "permit_type",
  "status",
  "description",
  "proposed_height_ft",
  "version",
] as const;

const FLOOD_HAZARD: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-156.4708, 20.8938],
      [-156.4628, 20.8938],
      [-156.4628, 20.8998],
      [-156.4708, 20.8998],
      [-156.4708, 20.8938],
    ],
  ],
};

export const DEFAULT_PROPOSAL: GeoJsonPolygon = {
  type: "Polygon",
  coordinates: [
    [
      [-156.4682, 20.8945],
      [-156.465, 20.8945],
      [-156.465, 20.8972],
      [-156.4682, 20.8972],
      [-156.4682, 20.8945],
    ],
  ],
};

/**
 * Headless deterministic workflow composed exclusively from public SDK
 * subpaths. The existing browser workbench can adopt it later without making
 * application-shell state part of the workflow contract.
 */
export class PlanningPermittingJourney {
  readonly #kernel: HonuaKernel;
  readonly #source: Source<PlanningRecordAttributes>;
  readonly #readonlySource: Source<PlanningRecordAttributes>;
  readonly #inspection: ConnectionInspection;
  readonly #geocoder: HonuaGeocodingClient;
  readonly #editFields: readonly EditWorkflowField[];
  #search: PlanningSearchResult | undefined;
  #analysis: PlanningAnalysisResult | undefined;
  readonly #submissions: PlanningSubmissionResult[] = [];

  private constructor(options: {
    kernel: HonuaKernel;
    connection: HonuaKernelConnection<PlanningRecordAttributes>;
    readonlyConnection: HonuaKernelConnection<PlanningRecordAttributes>;
    inspection: ConnectionInspection;
    geocoder: HonuaGeocodingClient;
  }) {
    this.#kernel = options.kernel;
    this.#source = options.connection.source();
    this.#readonlySource = options.readonlyConnection.source();
    this.#inspection = options.inspection;
    assertSourceTruth(this.#source, this.#readonlySource, this.#inspection);
    this.#geocoder = options.geocoder;
    this.#editFields = editFieldsFromMetadata(this.#source.descriptor.schema?.fields);
  }

  public static async connect(options: CreatePlanningJourneyOptions): Promise<PlanningPermittingJourney> {
    const baseUrl = normalizeFixtureOrigin(options.baseUrl);
    const kernel = createHonua({ discoveryCacheMaxEntries: 4 });
    try {
      const clientOptions = options.fetchFn ? { fetchFn: options.fetchFn } : undefined;
      const connection = await kernel.connect<PlanningRecordAttributes>(
        `${baseUrl}${PLANNING_SERVICE_PATH}/${PLANNING_WRITABLE_LAYER}`,
        {
          protocol: "auto",
          authorizationScopeFingerprint: `${PLANNING_FIXTURE_VERSION}:anonymous:writable`,
          ...(clientOptions ? { clientOptions } : {}),
        },
      );
      const readonlyConnection = await kernel.connect<PlanningRecordAttributes>(
        `${baseUrl}${PLANNING_SERVICE_PATH}/${PLANNING_READONLY_LAYER}`,
        {
          protocol: "auto",
          authorizationScopeFingerprint: `${PLANNING_FIXTURE_VERSION}:anonymous:readonly`,
          ...(clientOptions ? { clientOptions } : {}),
        },
      );
      const inspection = await connection.inspect();
      return new PlanningPermittingJourney({
        kernel,
        connection,
        readonlyConnection,
        inspection,
        geocoder: new HonuaGeocodingClient({
          baseUrl,
          locatorName: "Maui",
          ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        }),
      });
    } catch (error) {
      await kernel.dispose();
      throw error;
    }
  }

  public inspection(): ConnectionInspection {
    return this.#inspection;
  }

  public metadataFields(): readonly EditWorkflowField[] {
    return this.#editFields;
  }

  /**
   * The metadata-discovered writable source. Handed straight to the production
   * editor widget so create and update travel the same public `applyEdits`
   * seam this journey already validates capability truth against.
   */
  public editableSource(): Source<PlanningRecordAttributes> {
    return this.#source;
  }

  /** Bounded re-read of the applications on file, canonical and id-bearing. */
  public async listApplications(limit = PLANNING_APPLICATION_LIMIT): Promise<readonly PlanningApplication[]> {
    const result = await this.#source.query({
      where: "1=1",
      outFields: [...REQUIRED_EDIT_FIELDS, "last_edited_date"],
      pagination: { limit },
      returnGeometry: true,
      outSr: 4326,
    });
    return result.features.flatMap((feature) => {
      const id = Number(feature.attributes.OBJECTID);
      if (!Number.isFinite(id)) return [];
      return [toPlanningApplication(id, feature.attributes, feature.geometry)];
    });
  }

  /** Re-reads a single application so a commit or conflict can be reconciled. */
  public async loadApplication(featureId: number): Promise<PlanningApplication | undefined> {
    const result = await this.#source.query({
      where: `OBJECTID = ${Math.trunc(featureId)}`,
      outFields: [...REQUIRED_EDIT_FIELDS, "last_edited_date"],
      pagination: { limit: 1 },
      returnGeometry: true,
      outSr: 4326,
    });
    const feature = result.features[0];
    if (!feature) return undefined;
    const id = Number(feature.attributes.OBJECTID);
    if (!Number.isFinite(id)) return undefined;
    return toPlanningApplication(id, feature.attributes, feature.geometry);
  }

  public async search(address: string): Promise<PlanningSearchResult> {
    const candidates = await this.#geocoder.forwardGeocode(address, {
      maxResults: 5,
      countryCodes: "US",
      spatialReferenceWkid: 4326,
    });
    const geocode = candidates[0];
    if (!geocode) throw new Error(`No planning address matched “${address}”.`);
    const parcelTmk = geocode.attributes.ParcelTMK;
    if (typeof parcelTmk !== "string" || parcelTmk.length === 0) {
      throw new Error("The selected geocode candidate did not include a parcel TMK.");
    }
    const result = await this.#source.query({
      where: `parcel_tmk = '${escapeSqlLiteral(parcelTmk)}'`,
      outFields: [...REQUIRED_EDIT_FIELDS, "last_edited_date"],
      pagination: { limit: 1 },
      returnGeometry: true,
      outSr: 4326,
    });
    const feature = result.features[0];
    const featureId = Number(feature?.attributes.OBJECTID);
    if (!feature || !Number.isFinite(featureId)) {
      throw new Error(`Parcel ${parcelTmk} was not found in the planning source.`);
    }
    const search: PlanningSearchResult = {
      address,
      geocode,
      featureId,
      attributes: { ...feature.attributes },
      cacheStatus: this.#inspection.cacheStatus,
      sourceId: this.#source.descriptor.id,
      protocol: this.#source.descriptor.protocol,
    };
    this.#search = search;
    return search;
  }

  public async analyze(proposal: GeoJsonPolygon = DEFAULT_PROPOSAL): Promise<PlanningAnalysisResult> {
    const [xmin, ymin, xmax, ymax] = bbox(proposal);
    const candidates = await this.#source.query({
      spatialFilter: envelope(xmin, ymin, xmax, ymax, { wkid: 4326 }),
      pagination: { limit: PLANNING_CANDIDATE_LIMIT },
      outFields: ["OBJECTID", "parcel_tmk", "zoning", "flood_zone"],
      returnGeometry: true,
      outSr: 4326,
    });
    const overlap = intersect(proposal, FLOOD_HAZARD);
    const metadataSources = this.#inspection.sources
      .flatMap((source) => source.provenance)
      .map((entry) => entry.source);
    const analysis: PlanningAnalysisResult = {
      proposalAreaSquareMeters: round(area(proposal), 2),
      proposalPerimeterMeters: round(length(proposal, "meters"), 2),
      hazardOverlapSquareMeters: round(overlap ? area(overlap) : 0, 2),
      intersectsFloodHazard: booleanIntersects(proposal, FLOOD_HAZARD),
      boundedCandidateCount: candidates.features.length,
      candidateLimit: PLANNING_CANDIDATE_LIMIT,
      plan: [
        {
          id: "candidate-query",
          execution: "source",
          detail: `GeoServices envelope query capped at ${PLANNING_CANDIDATE_LIMIT} records.`,
        },
        {
          id: "client-geometry",
          execution: "client",
          detail: "@honua/geometry computes geodesic proposal area and perimeter.",
        },
        {
          id: "hazard-intersection",
          execution: "client",
          detail: "Exact polygon intersection runs only after the bounded source query.",
        },
      ],
      provenance: {
        fixtureVersion: PLANNING_FIXTURE_VERSION,
        metadataSources: [...new Set(metadataSources)],
        sourceId: this.#source.descriptor.id,
        protocol: this.#source.descriptor.protocol,
      },
      fidelity: {
        status: "exact-client-geometry",
        crs: "EPSG:4326",
        caveat: "The deterministic flood polygon is fixture data, not a current regulatory determination.",
      },
    };
    this.#analysis = analysis;
    return analysis;
  }

  public createDraft(proposal: GeoJsonPolygon = DEFAULT_PROPOSAL): PlanningDraft {
    const selected = this.requireSearch();
    const center = centroid(proposal);
    return {
      values: {
        permit_no: "DRAFT-2026-001",
        parcel_tmk: selected.attributes.parcel_tmk,
        address: selected.attributes.address,
        zoning: selected.attributes.zoning,
        flood_zone: selected.attributes.flood_zone,
        permit_type: "commercial",
        status: "draft",
        description: "Two-story tenant improvement with a deterministic site-plan attachment.",
        proposed_height_ft: 28,
      },
      geometry: {
        x: center.coordinates[0],
        y: center.coordinates[1],
        spatialReference: { wkid: 4326 },
      },
    };
  }

  public async submit(draft: PlanningDraft, scenario: PlanningScenario): Promise<PlanningSubmissionResult> {
    const selected = this.requireSearch();
    const source = scenario === "unsupported" ? this.#readonlySource : this.#source;
    const conflict = scenario === "conflict";
    const values: PlanningRecordAttributes = {
      ...(conflict ? selected.attributes : draft.values),
      ...(scenario === "invalid-domain" ? { permit_type: "casino" } : {}),
      ...(conflict ? { description: "fixture:conflict — stale planning review" } : {}),
    };
    const optimisticTransitions: Array<"applied" | "committed" | "rolled-back"> = [];
    const versionField = this.#editFields.find((field) => field.name === "version");
    const supportsConflict = source.capabilities.has("applyEdits") && versionField !== undefined;
    const session = createEditSession<PlanningRecordAttributes>({
      source,
      kind: conflict ? "update" : "create",
      feature: {
        ...(conflict ? { id: selected.featureId } : {}),
        attributes: values,
        geometry: { ...draft.geometry },
      },
      metadata: {
        fields: this.#editFields,
        primaryKey: "OBJECTID",
        conflict: {
          state: supportsConflict ? "supported" : "unsupported",
          ...(supportsConflict ? { versionField: versionField.name, value: selected.attributes.version } : {}),
        },
      },
      rollbackOnFailure: true,
      optimistic: {
        apply() {
          optimisticTransitions.push("applied");
        },
        commit() {
          optimisticTransitions.push("committed");
        },
        rollback() {
          optimisticTransitions.push("rolled-back");
        },
      },
    });
    if (scenario === "success") {
      session.stageAttachmentAdd("fixture://site-plan.pdf", {
        name: "site-plan.pdf",
        contentType: "application/pdf",
      });
    }
    if (scenario === "attachment-failure") {
      session.stageAttachmentAdd("fixture://too-large-site-plan.pdf", {
        name: "too-large-site-plan.pdf",
        contentType: "application/pdf",
      });
    }
    if (scenario === "unsupported") {
      session.stageAttachmentAdd("fixture://unsupported-site-plan.pdf", {
        name: "unsupported-site-plan.pdf",
        contentType: "application/pdf",
      });
    }

    const result = await session.submit();
    const submission: PlanningSubmissionResult = {
      scenario,
      status: result.status,
      result,
      optimisticTransitions,
      recoverable: result.status !== "succeeded",
      recovery: recoveryFor(scenario, result.status),
    };
    this.#submissions.push(submission);
    return submission;
  }

  public reviewModel(): PlanningReviewModel {
    if (!this.#search || !this.#analysis) {
      throw new Error("Complete address search and bounded analysis before exporting a planning review.");
    }
    return {
      kind: "honua.planning-permitting-review",
      version: 1,
      generatedAt: PLANNING_GENERATED_AT,
      fixtureVersion: PLANNING_FIXTURE_VERSION,
      semantic: {
        workflow: "search-analyze-edit-export",
        publicSurfaces: ["source-query", "geocoding", "geometry", "edit-session", "attachments"],
        failureScenarios: ["invalid-domain", "conflict", "attachment-failure", "unsupported"],
      },
      search: this.#search,
      analysis: this.#analysis,
      submissions: [...this.#submissions],
    };
  }

  public exportReview(): string {
    return JSON.stringify(this.reviewModel(), null, 2);
  }

  public submissions(): readonly PlanningSubmissionResult[] {
    return [...this.#submissions];
  }

  public async dispose(): Promise<void> {
    await this.#kernel.dispose();
  }

  private requireSearch(): PlanningSearchResult {
    if (!this.#search) throw new Error("Search and select a parcel before editing.");
    return this.#search;
  }
}

export function createPlanningPermittingJourney(
  options: CreatePlanningJourneyOptions,
): Promise<PlanningPermittingJourney> {
  return PlanningPermittingJourney.connect(options);
}

function toPlanningApplication(
  id: number,
  attributes: PlanningRecordAttributes,
  geometry: unknown,
): PlanningApplication {
  const point = typeof geometry === "object" && geometry !== null ? (geometry as Record<string, unknown>) : undefined;
  return {
    id,
    attributes: { ...attributes },
    ...(point ? { geometry: { ...point } } : {}),
  };
}

function normalizeFixtureOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Planning fixture baseUrl must be an absolute HTTP(S) origin.");
  }
  const originOnly = url.pathname === "/" && url.search === "" && url.hash === "";
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !originOnly
  ) {
    throw new Error("Planning fixture baseUrl must be a credential-free, origin-only HTTP(S) URL.");
  }
  return url.origin;
}

function assertSourceTruth(
  writable: Source<PlanningRecordAttributes>,
  readonly: Source<PlanningRecordAttributes>,
  inspection: ConnectionInspection,
): void {
  const writableDiscovery = inspection.sources.find((entry) => entry.descriptor.id === writable.descriptor.id);
  if (!writableDiscovery || writableDiscovery.discovery !== "metadata") {
    throw new Error("Planning workflow requires metadata-backed source discovery.");
  }
  for (const capability of ["query", "applyEdits", "attachments"] as const) {
    if (!writable.capabilities.has(capability)) {
      throw new Error(`Planning writable source metadata does not advertise ${capability}.`);
    }
  }
  if (!readonly.capabilities.has("query")) {
    throw new Error("Planning read-only source metadata does not advertise query.");
  }
  if (readonly.capabilities.has("applyEdits") || readonly.capabilities.has("attachments")) {
    throw new Error("Planning read-only source metadata unexpectedly advertises mutation capabilities.");
  }
}

function escapeSqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

function editFieldsFromMetadata(fields: readonly HonuaFieldInfo[] | undefined): readonly EditWorkflowField[] {
  if (!fields || fields.length === 0) {
    throw new Error("Planning workflow requires authoritative field metadata; none was advertised.");
  }
  const mapped = fields.map((field) => {
    const domain = editDomainFromMetadata(field);
    return {
      name: field.name,
      type: field.type,
      ...(field.alias !== undefined ? { alias: field.alias } : {}),
      ...(field.length !== undefined ? { length: field.length } : {}),
      ...(field.nullable !== undefined ? { nullable: field.nullable } : {}),
      ...(field.editable !== undefined ? { editable: field.editable } : {}),
      ...(field.defaultValue !== undefined ? { defaultValue: field.defaultValue } : {}),
      ...(domain ? { domain } : {}),
    } satisfies EditWorkflowField;
  });
  const byName = new Map(mapped.map((field) => [field.name, field]));
  const missing = REQUIRED_EDIT_FIELDS.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`Planning field metadata is incomplete: ${missing.join(", ")}.`);
  }
  for (const name of ["permit_type", "status"] as const) {
    const domain = byName.get(name)?.domain;
    if (domain?.type !== "coded-value" || !domain.codedValues || domain.codedValues.length === 0) {
      throw new Error(`Planning field metadata for ${name} requires a coded-value domain.`);
    }
  }
  const heightDomain = byName.get("proposed_height_ft")?.domain;
  if (heightDomain?.type !== "range" || !heightDomain.range) {
    throw new Error("Planning field metadata for proposed_height_ft requires a range domain.");
  }
  return mapped;
}

function editDomainFromMetadata(field: HonuaFieldInfo): EditWorkflowField["domain"] {
  const domain = field.domain;
  if (!domain) return undefined;
  if (domain.type === "codedValue") {
    const codedValues = Array.isArray(domain.codedValues) ? domain.codedValues : [];
    const values = codedValues.flatMap((value) => {
      if (typeof value !== "object" || value === null || !("code" in value)) return [];
      const code = value.code;
      if (typeof code !== "string" && typeof code !== "number") return [];
      return [{ name: typeof value.name === "string" ? value.name : String(code), code }];
    });
    return {
      type: "coded-value",
      ...(typeof domain.name === "string" ? { name: domain.name } : {}),
      codedValues: values,
    };
  }
  if (domain.type === "range") {
    const [minimum, maximum] = Array.isArray(domain.range) ? domain.range : [];
    const min = typeof minimum === "number" ? minimum : Number(minimum);
    const max = typeof maximum === "number" ? maximum : Number(maximum);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return {
        type: "range",
        ...(typeof domain.name === "string" ? { name: domain.name } : {}),
        range: [min, max],
      };
    }
  }
  return undefined;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function recoveryFor(scenario: PlanningScenario, status: EditWorkflowStatus): string {
  if (status === "succeeded") return "No recovery required; the edit and site-plan attachment committed.";
  if (scenario === "invalid-domain") return "Choose a permit type from metadata, then resubmit the unchanged draft.";
  if (scenario === "conflict") {
    return "Refresh the selected feature/version and explicitly reapply the reviewer’s changes.";
  }
  if (scenario === "attachment-failure") {
    return "Keep the committed feature edit and retry a smaller attachment separately.";
  }
  if (scenario === "unsupported") {
    return "Switch to a source advertising applyEdits and attachments; no mutation was attempted.";
  }
  return "Inspect the normalized failure result and retry only the failed operation.";
}
