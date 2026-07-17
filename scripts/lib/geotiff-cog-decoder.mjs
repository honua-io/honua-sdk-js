function copyArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

class HonuaRangeSource {
  #activeReader;
  #readers = new WeakMap();
  #closed = false;

  use(readRange, signal) {
    if (this.#closed) throw new Error("The GeoTIFF range source is closed.");
    this.#activeReader = readRange;
    this.#readers.set(signal, readRange);
  }

  async fetch(slices, signal) {
    if (this.#closed) throw new Error("The GeoTIFF range source is closed.");
    const readRange = (signal && this.#readers.get(signal)) || this.#activeReader;
    if (!readRange) throw new Error("GeoTIFF requested bytes outside an active Honua decoder operation.");
    return Promise.all(
      slices.map(async ({ offset, length }) => copyArrayBuffer(await readRange({ offset, length }))),
    );
  }

  get fileSize() {
    return null;
  }

  async close() {
    this.#closed = true;
    this.#activeReader = undefined;
  }
}

function dataType(image, sample) {
  const format = image.getSampleFormat(sample);
  const bits = image.getBitsPerSample(sample);
  const key = `${format}:${bits}`;
  const supported = {
    "1:8": "uint8",
    "1:16": "uint16",
    "1:32": "uint32",
    "2:8": "int8",
    "2:16": "int16",
    "2:32": "int32",
    "3:32": "float32",
    "3:64": "float64",
  };
  const value = supported[key];
  if (!value) throw new Error(`Unsupported GeoTIFF sample format ${format} with ${bits} bits.`);
  return value;
}

function crsFromImage(image) {
  const keys = image.getGeoKeys() ?? {};
  const code = keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey;
  if (!Number.isInteger(code) || code <= 0 || code === 32767) {
    return {
      kind: "unsupported",
      description: String(keys.GTCitationGeoKey ?? keys.GeogCitationGeoKey ?? "No authoritative CRS code"),
    };
  }
  return {
    kind: "known",
    authority: "EPSG",
    code: String(code),
    name: String(keys.GTCitationGeoKey ?? keys.GeogCitationGeoKey ?? `EPSG:${code}`),
  };
}

function colorInterpretation(photometric, sample, sampleCount) {
  if (photometric === 2 && sampleCount >= 3) return ["red", "green", "blue"][sample] ?? "alpha";
  if (sample === 0) return "gray";
  return undefined;
}

function isReducedImage(image) {
  const directory = image.getFileDirectory();
  const subfileType = directory.getValue("SubfileType");
  const newSubfileType = directory.getValue("NewSubfileType");
  return subfileType === 2 || ((newSubfileType ?? 0) & 1) === 1;
}

function overviewDecimation(baseWidth, imageWidth) {
  return Math.max(1, Math.round(baseWidth / imageWidth));
}

function decoderFactory(GeoTIFF) {
  return ({ assetUrl }) => {
    const source = new HonuaRangeSource();
    let tiff;
    let images = [];
    let metadata;
    let disposed = false;

    return {
      async inspect(context) {
        source.use(context.readRange, context.signal);
        tiff ??= await GeoTIFF.fromSource(source, { cache: true }, context.signal);
        const imageCount = await tiff.getImageCount();
        images = await Promise.all(Array.from({ length: imageCount }, (_, index) => tiff.getImage(index)));
        const base = images[0];
        if (!base) throw new Error(`GeoTIFF ${assetUrl} contains no images.`);

        const tiledPyramid = images.every((image, index) => image.isTiled && (index === 0 || isReducedImage(image)));
        const [minX, minY, maxX, maxY] = base.getBoundingBox();
        const [resolutionX, resolutionY] = base.getResolution();
        const sampleCount = base.getSamplesPerPixel();
        const photometric = base.getFileDirectory().getValue("PhotometricInterpretation");
        const nodata = base.getGDALNoData();
        const decimations = images
          .slice(1)
          .map((image) => overviewDecimation(base.getWidth(), image.getWidth()))
          .filter((value, index, values) => value > 1 && values.indexOf(value) === index)
          .sort((left, right) => left - right);

        metadata = {
          format: tiledPyramid ? "cog" : "geotiff",
          width: base.getWidth(),
          height: base.getHeight(),
          crs: crsFromImage(base),
          bands: Array.from({ length: sampleCount }, (_, sample) => ({
            index: sample + 1,
            dataType: dataType(base, sample),
            name: colorInterpretation(photometric, sample, sampleCount),
            colorInterpretation: colorInterpretation(photometric, sample, sampleCount),
            ...(nodata === null ? {} : { nodata }),
          })),
          resolution: {
            x: Math.abs(resolutionX),
            y: Math.abs(resolutionY),
            unit: crsFromImage(base).code?.startsWith("4") ? "degree" : "metre",
          },
          footprint: {
            type: "Polygon",
            coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]],
          },
          overviewDecimations: decimations,
        };
        return metadata;
      },

      async readWindow(request, context) {
        if (!metadata || !tiff || images.length === 0) throw new Error("Inspect the GeoTIFF before reading a window.");
        source.use(context.readRange, context.signal);
        const decimation = request.sampling?.overviewDecimation ?? 1;
        const imageIndex = images.findIndex(
          (image) => overviewDecimation(metadata.width, image.getWidth()) === decimation,
        );
        if (imageIndex < 0) throw new Error(`GeoTIFF overview decimation ${decimation} is unavailable.`);
        const image = images[imageIndex];
        const left = Math.max(0, Math.floor(request.x / decimation));
        const top = Math.max(0, Math.floor(request.y / decimation));
        const right = Math.min(image.getWidth(), Math.ceil((request.x + request.width) / decimation));
        const bottom = Math.min(image.getHeight(), Math.ceil((request.y + request.height) / decimation));
        const bands = request.bands ?? metadata.bands.map((band) => band.index);
        const width = request.sampling?.width ?? request.width;
        const height = request.sampling?.height ?? request.height;
        const values = await image.readRasters({
          window: [left, top, right, bottom],
          samples: bands.map((band) => band - 1),
          width,
          height,
          resampleMethod: request.sampling?.resampling ?? "nearest",
          interleave: false,
          signal: context.signal,
        });
        return {
          width,
          height,
          bands: bands.map((band, index) => ({ band, values: values[index] })),
        };
      },

      async dispose() {
        if (disposed) return;
        disposed = true;
        await tiff?.close();
        await source.close();
        images = [];
        metadata = undefined;
      },
    };
  };
}

/** Load GeoTIFF.js only when a caller explicitly opens a direct COG session. */
export async function loadGeoTiffCogDecoderFactory() {
  const { GeoTIFF } = await import("geotiff");
  return decoderFactory(GeoTIFF);
}
