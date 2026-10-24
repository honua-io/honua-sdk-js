export class DatasetImportTaskApiError extends Error {
  constructor(readonly status: number) {
    super(`Dataset import request failed (${status}).`);
    this.name = "DatasetImportTaskApiError";
  }
}
