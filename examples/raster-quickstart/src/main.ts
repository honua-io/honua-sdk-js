import type { CogDecoderFactory, StacCogAssetToMapLibreMap } from "@honua/sdk-js/cog";
import { directCogSource, openRasterSession } from "@honua/sdk-js/raster";

export async function displayCog(map: StacCogAssetToMapLibreMap, decoderFactory: CogDecoderFactory) {
  const raster = await openRasterSession(
    directCogSource({
      id: "oahu-natural-color",
      url: "https://assets.example/fixtures/oahu-natural-color-v1",
      mediaType: "image/tiff; application=geotiff; profile=cloud-optimized",
    }),
    { decoderFactory, decoderExecution: "worker" },
  );

  const mounted = raster.mountMapLibre(map, {
    bands: { mode: "rgb", red: 1, green: 2, blue: 3 },
    resampling: "bilinear",
  });
  await mounted.ready;
  return { raster, mounted };
}
