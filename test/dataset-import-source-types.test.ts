import type {
  CreateDatasetImportTask,
  DatasetImportArtifactSource,
  DatasetImportServerJobArtifactSource,
  DatasetImportServerJobSource,
  DatasetImportSource,
} from "@honua/sdk-js/control-plane";
import { expectTypeOf, it } from "vitest";

type BareJobSource = { kind: "server-job-artifact"; fileName: string; totalBytes: number };

it("requires both the canonical Server job reference and digest on task sources", () => {
  expectTypeOf<BareJobSource>().not.toMatchTypeOf<CreateDatasetImportTask["source"]>();
  expectTypeOf<BareJobSource & { expectedSha256: string }>().not.toMatchTypeOf<DatasetImportSource>();
  expectTypeOf<
    BareJobSource & { serverJobArtifact: DatasetImportServerJobArtifactSource }
  >().not.toMatchTypeOf<DatasetImportSource>();
  expectTypeOf<
    Extract<DatasetImportSource, { kind: "server-job-artifact" }>
  >().toEqualTypeOf<DatasetImportServerJobSource>();
  expectTypeOf<DatasetImportServerJobSource>().toMatchTypeOf<CreateDatasetImportTask["source"]>();
});

it("keeps browser files usable and requires local artifact provenance without mixing source kinds", () => {
  expectTypeOf<{ kind: "browser-file"; fileName: string; totalBytes: number }>().toMatchTypeOf<DatasetImportSource>();
  expectTypeOf<{
    kind: "local-process-artifact";
    fileName: string;
    totalBytes: number;
  }>().not.toMatchTypeOf<DatasetImportSource>();
  expectTypeOf<{
    kind: "local-process-artifact";
    fileName: string;
    totalBytes: number;
    artifact: DatasetImportArtifactSource;
  }>().toMatchTypeOf<DatasetImportSource>();
  expectTypeOf<
    BareJobSource & {
      expectedSha256: string;
      serverJobArtifact: DatasetImportServerJobArtifactSource;
      artifact: DatasetImportArtifactSource;
    }
  >().not.toMatchTypeOf<DatasetImportSource>();
});
