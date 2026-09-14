export function complaintDistanceRequest({ day, dateField, geometry, geometryType, startTimes = [] }) {
  const instant = new Date(`${day}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(instant.getTime()) ||
    instant.toISOString().slice(0, 10) !== day
  )
    throw new Error("Choose a valid calendar date.");
  if (!dateField || !geometry || !["esriGeometryPoint", "esriGeometryPolyline"].includes(geometryType))
    throw new Error("Complaint distance queries require a date field and point or track geometry.");
  const field = `"${dateField.replaceAll('"', '""')}"`;
  const end = new Date(instant.getTime() + 86_400_000).toISOString().slice(0, 10);
  const filters = [`${field} >= TIMESTAMP '${day} 00:00:00'`, `${field} < TIMESTAMP '${end} 00:00:00'`];
  if (startTimes.length) {
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const value of startTimes) {
      const time = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
      if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()))
        throw new Error("Selected flight records must have valid start times.");
      first = Math.min(first, time);
      last = Math.max(last, time);
    }
    const timestamp = (time) => new Date(time).toISOString().replace("T", " ").replace("Z", "");
    filters.push(`${field} >= TIMESTAMP '${timestamp(first)}'`, `${field} <= TIMESTAMP '${timestamp(last)}'`);
  }
  return {
    where: filters.join(" AND "),
    geometry,
    geometryType,
    spatialRel: "esriSpatialRelIntersects",
    distance: 0.5,
    units: "esriSRUnit_StatuteMile",
    returnGeometry: false,
    // Published 0.1.9-beta.0 drops first-class REST distance options. Keep this
    // explicit bridge until the fix in SDK #1731 is available in the registry.
    extraParams: { inSR: 4326, distance: 0.5, units: "esriSRUnit_StatuteMile" },
  };
}

export async function matchingDistanceIds(request, query, signal) {
  signal.throwIfAborted();
  const [counts, result] = await Promise.all([
    request({ ...query, signal, extraParams: { ...query.extraParams, returnCountOnly: true } }),
    request({ ...query, signal, extraParams: { ...query.extraParams, returnIdsOnly: true } }),
  ]);
  signal.throwIfAborted();
  const count = counts?.count;
  const expected =
    typeof count === "number" || (typeof count === "string" && /^\d+$/.test(count)) ? Number(count) : Number.NaN;
  if (
    !Number.isSafeInteger(expected) ||
    expected < 0 ||
    !Array.isArray(result?.objectIds) ||
    counts?.exceededTransferLimit ||
    result.exceededTransferLimit
  )
    throw new Error("Complete complaint highlight identities and count are unavailable.");
  const ids = result.objectIds.map((id) => {
    if ((typeof id === "number" && Number.isSafeInteger(id)) || (typeof id === "string" && id.trim()))
      return String(id);
    throw new Error("A complaint has no valid identity.");
  });
  if (ids.length !== expected || new Set(ids).size !== expected)
    throw new Error("Complaint highlight identities do not match the server count.");
  return ids;
}
