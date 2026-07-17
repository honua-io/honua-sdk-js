/** Internal credential-free endpoint normalization shared by discovery and offline manifests. */

const CREDENTIAL_ENDPOINT_PARAMETERS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "bearer",
  "client_secret",
  "code",
  "id_token",
  "jwt",
  "password",
  "passwd",
  "refresh_token",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "sig",
  "signature",
  "token",
]);

const AMBIGUOUS_CREDENTIAL_ENDPOINT_PARAMETERS = new Set([
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "code",
  "credential",
  "key",
  "ocp-apim-subscription-key",
  "secret",
  "session",
  "session_id",
  "sessionid",
  "subscription-key",
  "subscription_key",
]);

const AZURE_SAS_PARAMETER =
  /^(?:rscc|rscd|rsce|rscl|rsct|saoid|scid|sdd|se|ses|sig|sip|si|ske|skoid|sks|skt|sktid|skv|sp|spr|sr|srt|ss|st|suoid|sv)$/;
const CLOUDFRONT_SIGNED_URL_PARAMETER = /^(?:expires|key-pair-id|policy|signature)$/;
const AWS_V2_SIGNED_URL_PARAMETER = /^(?:awsaccesskeyid|expires|securitytoken|signature)$/;
const GCS_V2_SIGNED_URL_PARAMETER = /^(?:expires|googleaccessid|signature)$/;

/** @internal Returns `undefined` instead of retaining a domain-specific error class. */
export function tryNormalizeDiscoveryEndpoint(
  endpoint: string | URL,
  transientQueryParameters: readonly string[] = [],
  preserveAmbiguousCredentialParameters = false,
): string | undefined {
  try {
    const parsed = new URL(endpoint.toString());
    const callerTransient = new Set(transientQueryParameters.map((value) => value.toLowerCase()));
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    const isSignedUrlTransient = signedUrlTransientParameter(parsed.searchParams);
    const retained = [...parsed.searchParams.entries()]
      .filter(([key]) => {
        const normalized = key.toLowerCase();
        return (
          !callerTransient.has(normalized) &&
          !isSignedUrlTransient(normalized) &&
          !(
            isCredentialEndpointParameter(normalized) &&
            !(preserveAmbiguousCredentialParameters && AMBIGUOUS_CREDENTIAL_ENDPOINT_PARAMETERS.has(normalized))
          )
        );
      })
      .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey === rightKey ? compareText(leftValue, rightValue) : compareText(leftKey, rightKey),
      );
    parsed.search = "";
    for (const [key, value] of retained) parsed.searchParams.append(key, value);
    while (parsed.pathname.length > 1 && parsed.pathname.endsWith("/")) parsed.pathname = parsed.pathname.slice(0, -1);
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return undefined;
  }
}

function isCredentialEndpointParameter(normalized: string): boolean {
  return (
    CREDENTIAL_ENDPOINT_PARAMETERS.has(normalized) ||
    AMBIGUOUS_CREDENTIAL_ENDPOINT_PARAMETERS.has(normalized) ||
    normalized.startsWith("x-amz-") ||
    normalized.startsWith("x-goog-")
  );
}

function signedUrlTransientParameter(parameters: URLSearchParams): (name: string) => boolean {
  const names = new Set([...parameters.keys()].map((name) => name.toLowerCase()));
  const azure = names.has("sig") && [...names].some((name) => name !== "sig" && AZURE_SAS_PARAMETER.test(name));
  const signedV2 = names.has("signature");
  const cloudFront = signedV2 && names.has("key-pair-id");
  const aws = signedV2 && names.has("awsaccesskeyid");
  const gcs = signedV2 && names.has("googleaccessid");
  return (name) =>
    (azure && AZURE_SAS_PARAMETER.test(name)) ||
    (cloudFront && CLOUDFRONT_SIGNED_URL_PARAMETER.test(name)) ||
    (aws && AWS_V2_SIGNED_URL_PARAMETER.test(name)) ||
    (gcs && GCS_V2_SIGNED_URL_PARAMETER.test(name));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
