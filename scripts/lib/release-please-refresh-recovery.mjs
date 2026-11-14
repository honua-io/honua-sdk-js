export class ReleasePleaseRefreshRecoveryRequired extends Error {}

export async function prepareReleasePleaseRefresh(input, prepare) {
  try {
    return await prepare(input);
  } catch (error) {
    if (!(error instanceof ReleasePleaseRefreshRecoveryRequired) || input.retryAttempted) throw error;
    return { recoveryRequired: true, reason: error.message };
  }
}
