import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";

/** One metric series: a metric name and one set of attribute values. Counters sum; histograms keep count, sum, min and max. */
export type TelemetrySeries = {
  name: string;
  kind: "counter" | "upDownCounter" | "histogram";
  unit?: string;
  attributes: Record<string, string | number | boolean>;
  count: number;
  sum: number;
  min: number;
  max: number;
};

/**
 * Durable's metrics, kept in process memory for this host and lost on restart. Spans are not recorded: their error status
 * can carry tool or model text. Metric attributes are Durable's fixed names (task, phase, outcome, report type), so the
 * series stay content-free; past `maxSeries` new series are counted as dropped, never stored.
 */
export function localTelemetry(options: { maxSeries?: number } = {}) {
  const maxSeries = options.maxSeries ?? 256,
    series = new Map<string, TelemetrySeries>(),
    since = Date.now();
  let droppedSeries = 0;
  const record = (
    name: string,
    kind: TelemetrySeries["kind"],
    unit: string | undefined,
    value: number,
    attributes: SpanAttributes = {},
  ) => {
    const flat = Object.fromEntries(
      Object.entries(attributes)
        .filter((pair): pair is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof pair[1]))
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const key = JSON.stringify([name, flat]);
    let item = series.get(key);
    if (!item) {
      if (series.size >= maxSeries) {
        droppedSeries++;
        return;
      }
      item = { name, kind, ...(unit ? { unit } : {}), attributes: flat, count: 0, sum: 0, min: value, max: value };
      series.set(key, item);
    }
    item.count++;
    item.sum += value;
    item.min = Math.min(item.min, value);
    item.max = Math.max(item.max, value);
  };
  const span: TelemetrySpan = {
    startSpan: (_options, callback) => Promise.resolve(callback(span)),
    addLink: () => {},
    addEvent: () => {},
    setAttributes: () => {},
    setStatus: () => {},
  };
  const context: TelemetryContext & Required<Pick<TelemetryContext, "metrics">> = {
    startSpan: span.startSpan,
    metrics: {
      counter: (name, instrument) => ({ add: (value, attributes) => record(name, "counter", instrument?.unit, value, attributes) }),
      upDownCounter: (name, instrument) => ({
        add: (value, attributes) => record(name, "upDownCounter", instrument?.unit, value, attributes),
      }),
      histogram: (name, instrument) => ({ record: (value, attributes) => record(name, "histogram", instrument?.unit, value, attributes) }),
    },
  };
  return {
    context,
    snapshot: () => ({
      since,
      maxSeries,
      droppedSeries,
      metrics: [...series.values()].map((item) => ({ ...item, attributes: { ...item.attributes } })),
    }),
  };
}
export type LocalTelemetry = ReturnType<typeof localTelemetry>;
