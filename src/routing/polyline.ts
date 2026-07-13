/**
 * Dependency-free Google encoded-polyline decoder used by the Valhalla
 * adapter (Valhalla encodes leg shapes with 1e-6 precision).
 *
 * @packageDocumentation
 */

/**
 * Decode an encoded polyline string into `[longitude, latitude]` pairs.
 *
 * @param encoded - The encoded polyline.
 * @param precision - Coordinate precision divisor; `1e6` for Valhalla shapes,
 *   `1e5` for classic Google/OSRM polylines.
 *
 * @experimental
 */
export function decodePolyline(encoded: string, precision = 1e6): [number, number][] {
  const coordinates: [number, number][] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;

  while (index < encoded.length) {
    latitude += decodeValue();
    longitude += decodeValue();
    coordinates.push([longitude / precision, latitude / precision]);
  }

  return coordinates;

  function decodeValue(): number {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      if (index >= encoded.length) {
        throw new Error("Invalid encoded polyline: truncated value.");
      }
      byte = encoded.charCodeAt(index) - 63;
      index += 1;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  }
}
