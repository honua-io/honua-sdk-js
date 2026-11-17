// Packed consumer: a source created with the installed @honua/sdk-js tarball,
// handed to installed @honua/app-platform components.
import { adoptHonuaSdkSource, createHonuaApplicationContext, createHonuaFeatureTable } from "@honua/app-platform/web-components";
import { connect } from "@honua/sdk-js/honua";

export async function bindSdkSource(endpoint: string): Promise<void> {
  const connection = await connect({
    authorizationScopeFingerprint: "packed-consumer-scope",
    endpoint,
    protocol: "geoservices-feature-service",
  });
  const sdkSource = connection.source();
  const source = adoptHonuaSdkSource(sdkSource);

  createHonuaApplicationContext({ status: "ready", binding: { source, sourceIdentity: source.descriptor.id } });
  createHonuaFeatureTable({ source: sdkSource, sourceId: sdkSource.descriptor.id });
  createHonuaFeatureTable({ source, sourceId: source.descriptor.id });

  // Each package ships its own contract types, so the typed
  // protocol()/adapter() results stay unrelated without the helper.
  // @ts-expect-error a raw @honua/sdk-js source is not an app-platform Source
  createHonuaApplicationContext({ status: "ready", binding: { source: sdkSource } });
  // @ts-expect-error members other than protocol()/adapter() are still checked
  adoptHonuaSdkSource({ ...sdkSource, descriptor: 1 });
}
