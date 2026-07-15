export function setupPreparedSdkArtifact(
  projectRoot?: string,
  environment?: Record<string, string | undefined>,
): (() => void) | undefined;

export default function setupDefaultPreparedSdkArtifact(): (() => void) | undefined;
