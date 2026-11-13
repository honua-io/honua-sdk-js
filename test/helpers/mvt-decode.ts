// Minimal Mapbox Vector Tile reader for tests: one layer's features with their
// properties and polygon rings in longitude/latitude.

export interface DecodedTileFeature {
  readonly properties: Record<string, unknown>;
  readonly rings: number[][][];
}

const MOVE_TO = 1;
const LINE_TO = 2;
const CLOSE_PATH = 7;

class ProtobufReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.offset >= this.bytes.length;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = this.bytes[this.offset++] as number;
      result += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return result;
      shift += 7;
    }
  }

  field(): { readonly number: number; readonly wireType: number } {
    const key = this.varint();
    return { number: Math.floor(key / 8), wireType: key % 8 };
  }

  bytesField(): Uint8Array {
    const length = this.varint();
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  skip(wireType: number): void {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.bytesField();
    else if (wireType === 1) this.offset += 8;
    else if (wireType === 5) this.offset += 4;
  }
}

function packed(bytes: Uint8Array): number[] {
  const reader = new ProtobufReader(bytes);
  const values: number[] = [];
  while (!reader.done) values.push(reader.varint());
  return values;
}

function zigzag(value: number): number {
  return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
}

function readValue(bytes: Uint8Array): unknown {
  const reader = new ProtobufReader(bytes);
  const { number, wireType } = reader.field();
  if (number === 1) return new TextDecoder().decode(reader.bytesField());
  if (wireType === 0) return reader.varint();
  return undefined;
}

function tileRings(commands: number[]): number[][][] {
  const rings: number[][][] = [];
  let ring: number[][] = [];
  let [x, y] = [0, 0];
  for (let index = 0; index < commands.length; ) {
    const command = (commands[index] as number) & 0x7;
    const count = (commands[index++] as number) >> 3;
    if (command === CLOSE_PATH) {
      ring.push(ring[0] as number[]);
      rings.push(ring);
      ring = [];
      continue;
    }
    for (let repeat = 0; repeat < count && (command === MOVE_TO || command === LINE_TO); repeat++) {
      x += zigzag(commands[index++] as number);
      y += zigzag(commands[index++] as number);
      ring.push([x, y]);
    }
  }
  return rings;
}

function toLonLat(
  [x, y]: number[],
  tile: { readonly x: number; readonly y: number; readonly z: number; readonly extent: number },
) {
  const scale = 2 ** tile.z;
  const lon = ((tile.x + (x as number) / tile.extent) / scale) * 360 - 180;
  const mercator = Math.PI * (1 - (2 * (tile.y + (y as number) / tile.extent)) / scale);
  return [lon, (Math.atan(Math.sinh(mercator)) * 180) / Math.PI];
}

/** Decode the features of `layerName` in tile `x`/`y`/`z`. */
export function decodeTileLayer(
  data: Uint8Array,
  layerName: string,
  position: { readonly x: number; readonly y: number; readonly z: number },
): DecodedTileFeature[] {
  const tile = new ProtobufReader(data);
  while (!tile.done) {
    const { number, wireType } = tile.field();
    if (number !== 3) {
      tile.skip(wireType);
      continue;
    }
    const layer = new ProtobufReader(tile.bytesField());
    const parts = {
      name: "",
      keys: [] as string[],
      values: [] as unknown[],
      features: [] as Uint8Array[],
      extent: 4096,
    };
    while (!layer.done) {
      const field = layer.field();
      if (field.number === 1) parts.name = new TextDecoder().decode(layer.bytesField());
      else if (field.number === 2) parts.features.push(layer.bytesField());
      else if (field.number === 3) parts.keys.push(new TextDecoder().decode(layer.bytesField()));
      else if (field.number === 4) parts.values.push(readValue(layer.bytesField()));
      else if (field.number === 5) parts.extent = layer.varint();
      else layer.skip(field.wireType);
    }
    if (parts.name !== layerName) continue;
    return parts.features.map((bytes) => {
      const feature = new ProtobufReader(bytes);
      let tags: number[] = [];
      let geometry: number[] = [];
      while (!feature.done) {
        const field = feature.field();
        if (field.number === 2) tags = packed(feature.bytesField());
        else if (field.number === 4) geometry = packed(feature.bytesField());
        else feature.skip(field.wireType);
      }
      const properties: Record<string, unknown> = {};
      for (let index = 0; index < tags.length; index += 2) {
        properties[parts.keys[tags[index] as number] as string] = parts.values[tags[index + 1] as number];
      }
      const rings = tileRings(geometry).map((ring) =>
        ring.map((point) => toLonLat(point, { ...position, extent: parts.extent })),
      );
      return { properties, rings };
    });
  }
  return [];
}
