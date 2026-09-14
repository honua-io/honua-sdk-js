export const FLIGHT_CHART: Readonly<{
  field: "start_t";
  intervalMilliseconds: number;
  alignment: "equalIntervalsFromStartTime";
  trimIncompleteTimeInterval: true;
  nullPolicy: "null";
}>;

export interface FlightBin {
  start: number;
  end: number;
  count: number;
  ids: string[];
}

export function flightChart(records: readonly { id: string; timestamp: number }[]): {
  start: number | null;
  end: number | null;
  bins: FlightBin[];
  trimmed: number;
};
