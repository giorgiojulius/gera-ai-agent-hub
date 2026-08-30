/**
 * Artifact helpers: chart/map spec parsing for ```chart and ```map fences
 * plus shared download utilities used by the artifact cards.
 */

export type ChartKind = "line" | "bar" | "area" | "pie" | "donut" | "radar" | "scatter";

export type ChartSeries = {
  key: string;
  label: string;
  color: string;
};

export type ChartSpec = {
  kind: ChartKind;
  title?: string;
  xKey: string;
  series: ChartSeries[];
  data: Record<string, unknown>[];
  stacked: boolean;
};

type Row = Record<string, unknown>;

/** Inkberry palette: mulberry first, then calm muted tones that stay easy on the eyes. */
export const CHART_COLORS: string[] = [
  "hsl(333, 45%, 36%)",
  "hsl(30, 40%, 45%)",
  "hsl(214, 32%, 46%)",
  "hsl(352, 42%, 56%)",
  "hsl(150, 24%, 38%)",
  "hsl(268, 24%, 52%)",
  "hsl(42, 42%, 40%)",
  "hsl(200, 22%, 44%)",
];

const KIND_ALIASES: Record<string, ChartKind> = {
  line: "line",
  lines: "line",
  linechart: "line",
  trend: "line",
  timeseries: "line",
  bar: "bar",
  bars: "bar",
  barchart: "bar",
  column: "bar",
  columns: "bar",
  histogram: "bar",
  area: "area",
  areachart: "area",
  pie: "pie",
  piechart: "pie",
  donut: "donut",
  doughnut: "donut",
  ring: "donut",
  radar: "radar",
  spider: "radar",
  scatter: "scatter",
  scatterplot: "scatter",
  xy: "scatter",
  bubble: "scatter",
};

/** Coerces numeric-looking values ("1,200", "45%", "$3.5") to numbers. */
export function coerceNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.replace(/[\s,%$€£₽]/g, "");
  if (!cleaned || !/[0-9]/.test(cleaned)) {
    return null;
  }
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function extractJson(raw: string): unknown {
  const text = raw.trim();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // fall through to salvage
  }
  const start = text.search(/[{[]/);
  if (start === -1) {
    return null;
  }
  const close = text[start] === "{" ? "}" : "]";
  const end = text.lastIndexOf(close);
  if (end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowsFrom(value: unknown): Row[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const rows = value.filter(isRow);
  return rows.length > 0 ? rows : null;
}

/** Converts Chart.js-style {labels, datasets} payloads into flat rows. */
function fromChartJs(obj: Row): { rows: Row[]; xKey: string; seriesKeys: string[] } | null {
  const labels = obj.labels;
  const datasets = obj.datasets;
  if (!Array.isArray(labels) || !Array.isArray(datasets) || labels.length === 0) {
    return null;
  }
  const xKey = "__label";
  const rows: Row[] = labels.map((label) => ({ [xKey]: typeof label === "string" ? label : String(label) }));
  const seriesKeys: string[] = [];
  datasets.forEach((entry, index) => {
    if (!isRow(entry) || !Array.isArray(entry.data)) {
      return;
    }
    const key =
      typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : `Series ${index + 1}`;
    seriesKeys.push(key);
    (entry.data as unknown[]).forEach((value, i) => {
      if (rows[i]) {
        rows[i][key] = value;
      }
    });
  });
  return seriesKeys.length > 0 ? { rows, xKey, seriesKeys } : null;
}

/**
 * Parses the JSON inside a ```chart fence into a normalized spec.
 * Forgiving by design: accepts bare arrays, Chart.js payloads, string
 * numbers, and missing series/xKey (both are inferred from the data).
 */
export function parseChartSpec(raw: string): ChartSpec | null {
  const parsed = extractJson(raw);
  if (parsed == null) {
    return null;
  }

  let obj: Row = {};
  let rows: Row[] | null = null;
  let xKeyHint: string | undefined;
  let seriesHint: unknown;

  if (Array.isArray(parsed)) {
    rows = rowsFrom(parsed);
  } else if (isRow(parsed)) {
    obj = parsed;
    rows = rowsFrom(obj.data) ?? rowsFrom(obj.rows) ?? rowsFrom(obj.values) ?? rowsFrom(obj.points);
    if (!rows) {
      const chartJs = fromChartJs(obj);
      if (chartJs) {
        rows = chartJs.rows;
        xKeyHint = chartJs.xKey;
        seriesHint = chartJs.seriesKeys;
      }
    }
    seriesHint = seriesHint ?? obj.series ?? obj.yKeys ?? obj.metrics;
    const xCandidate = obj.xKey ?? obj.x ?? obj.labelKey ?? obj.nameKey ?? obj.categoryKey;
    if (typeof xCandidate === "string" && xCandidate.trim()) {
      xKeyHint = xCandidate.trim();
    }
  }

  if (!rows || rows.length === 0) {
    return null;
  }
  const rowList = rows.slice(0, 500);

  const keys = [...new Set(rowList.flatMap((row) => Object.keys(row)))];
  if (keys.length === 0) {
    return null;
  }
  const numericKeys = keys.filter((key) => rowList.some((row) => coerceNumber(row[key]) !== null));

  let xKey = xKeyHint && keys.includes(xKeyHint) ? xKeyHint : undefined;
  if (!xKey) {
    xKey =
      keys.find((key) => rowList.some((row) => typeof row[key] === "string" && coerceNumber(row[key]) === null)) ??
      keys[0];
  }

  const requested: { key: string; label?: string; color?: string }[] = [];
  if (Array.isArray(seriesHint)) {
    for (const item of seriesHint) {
      if (typeof item === "string" && item.trim()) {
        requested.push({ key: item.trim() });
      } else if (isRow(item) && typeof item.key === "string" && item.key.trim()) {
        requested.push({
          key: item.key.trim(),
          label:
            typeof item.label === "string"
              ? item.label
              : typeof item.name === "string"
                ? item.name
                : undefined,
          color: typeof item.color === "string" ? item.color : undefined,
        });
      }
    }
  } else if (typeof seriesHint === "string" && seriesHint.trim()) {
    requested.push({ key: seriesHint.trim() });
  }

  let series = requested.filter((item) => keys.includes(item.key) && item.key !== xKey);
  if (series.length === 0) {
    series = numericKeys.filter((key) => key !== xKey).map((key) => ({ key }));
  }
  series = series.slice(0, 8);
  if (series.length === 0) {
    return null;
  }

  const data: Row[] = rowList.map((row) => {
    const next: Row = { ...row };
    for (const item of series) {
      const num = coerceNumber(row[item.key]);
      if (num !== null) {
        next[item.key] = num;
      }
    }
    return next;
  });

  const kindRaw = [obj.type, obj.kind, obj.chart, obj.chartType].find(
    (value): value is string => typeof value === "string",
  );
  let kind: ChartKind | undefined = kindRaw
    ? KIND_ALIASES[kindRaw.trim().toLowerCase().replace(/[\s_-]/g, "")]
    : undefined;
  if (!kind) {
    kind = series.length === 1 && data.length <= 12 ? "bar" : "line";
  }
  if (kind === "scatter") {
    const numericX = data.filter((row) => coerceNumber(row[xKey]) !== null).length;
    if (numericX < Math.max(2, data.length * 0.8)) {
      kind = "line";
    }
  }
  if ((kind === "pie" || kind === "donut") && data.length > 12) {
    kind = "bar";
  }

  const title = typeof obj.title === "string" && obj.title.trim() ? obj.title.trim() : undefined;

  return {
    kind,
    title,
    xKey,
    stacked: obj.stacked === true,
    series: series.map((item, index) => ({
      key: item.key,
      label: item.label?.trim() || item.key,
      color: item.color?.trim() || CHART_COLORS[index % CHART_COLORS.length],
    })),
    data,
  };
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(filename: string, text: string, mime = "text/plain;charset=utf-8"): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Serializes a rendered SVG element (chart/diagram) into a downloadable file. */
export function downloadSvgElement(svg: SVGElement, filename: string): void {
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const box = svg.getBoundingClientRect();
  if (!clone.getAttribute("width") && box.width > 0) {
    clone.setAttribute("width", String(Math.round(box.width)));
    clone.setAttribute("height", String(Math.round(box.height)));
  }
  const markup = new XMLSerializer().serializeToString(clone);
  downloadText(filename, `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`, "image/svg+xml");
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "artifact"
  );
}

export type MapMarker = {
  lat: number;
  lng: number;
  label?: string;
  description?: string;
};

export type MapSpec = {
  title?: string;
  markers: MapMarker[];
  /** Resolved polyline coords (explicit path, or marker order when route: true). */
  route: [number, number][] | null;
  /** True when pins are numbered in visit order (route through markers). */
  numbered: boolean;
  center: [number, number] | null;
  zoom: number | null;
};

function validLat(value: number): boolean {
  return value >= -90 && value <= 90;
}

function validLng(value: number): boolean {
  return value >= -180 && value <= 180;
}

/** Reads a [lat, lng] pair from an array or a {lat, lng}-shaped object. */
function coordPair(value: unknown): [number, number] | null {
  if (Array.isArray(value) && value.length >= 2) {
    const lat = coerceNumber(value[0]);
    const lng = coerceNumber(value[1]);
    if (lat !== null && lng !== null && validLat(lat) && validLng(lng)) {
      return [lat, lng];
    }
    return null;
  }
  if (isRow(value)) {
    const lat = coerceNumber(value.lat ?? value.latitude);
    const lng = coerceNumber(value.lng ?? value.lon ?? value.longitude);
    if (lat !== null && lng !== null && validLat(lat) && validLng(lng)) {
      return [lat, lng];
    }
  }
  return null;
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function markerFrom(value: unknown): MapMarker | null {
  if (Array.isArray(value)) {
    const pair = coordPair(value);
    return pair ? { lat: pair[0], lng: pair[1] } : null;
  }
  if (!isRow(value)) {
    return null;
  }
  let lat = coerceNumber(value.lat ?? value.latitude ?? value.y);
  let lng = coerceNumber(value.lng ?? value.lon ?? value.long ?? value.longitude ?? value.x);
  if (lat === null || lng === null || !validLat(lat) || !validLng(lng)) {
    const pair = coordPair(value.coordinates ?? value.coords ?? value.position ?? value.location);
    if (!pair) {
      return null;
    }
    lat = pair[0];
    lng = pair[1];
  }
  return {
    lat,
    lng,
    label: textField(value.label ?? value.name ?? value.title ?? value.place ?? value.city),
    description: textField(value.description ?? value.desc ?? value.note ?? value.details ?? value.subtitle ?? value.address),
  };
}

/** Extracts pins and the first LineString from a GeoJSON FeatureCollection. */
function fromGeoJson(obj: Row): MapSpec | null {
  if (!Array.isArray(obj.features)) {
    return null;
  }
  const markers: MapMarker[] = [];
  let route: [number, number][] | null = null;
  for (const feature of obj.features.slice(0, 300)) {
    if (!isRow(feature) || !isRow(feature.geometry)) {
      continue;
    }
    const geometry = feature.geometry;
    const props = isRow(feature.properties) ? feature.properties : {};
    if (geometry.type === "Point" && Array.isArray(geometry.coordinates)) {
      const lng = coerceNumber(geometry.coordinates[0]);
      const lat = coerceNumber(geometry.coordinates[1]);
      if (lat !== null && lng !== null && validLat(lat) && validLng(lng)) {
        markers.push({
          lat,
          lng,
          label: textField(props.name ?? props.title ?? props.label),
          description: textField(props.description ?? props.desc),
        });
      }
    } else if (geometry.type === "LineString" && Array.isArray(geometry.coordinates) && !route) {
      const coords: [number, number][] = [];
      for (const point of geometry.coordinates.slice(0, 2000)) {
        if (Array.isArray(point)) {
          const lng = coerceNumber(point[0]);
          const lat = coerceNumber(point[1]);
          if (lat !== null && lng !== null && validLat(lat) && validLng(lng)) {
            coords.push([lat, lng]);
          }
        }
      }
      if (coords.length >= 2) {
        route = coords;
      }
    }
  }
  if (markers.length === 0 && !route) {
    return null;
  }
  return {
    title: textField(obj.title),
    markers,
    route,
    numbered: false,
    center: null,
    zoom: null,
  };
}

/**
 * Parses the JSON inside a ```map fence into a normalized spec.
 * Accepts {markers: [...]} objects, bare marker arrays, lat/lon alias
 * fields, GeoJSON FeatureCollections, and "route": true | [[lat,lng],...].
 */
export function parseMapSpec(raw: string): MapSpec | null {
  const parsed = extractJson(raw);
  if (parsed == null) {
    return null;
  }

  let obj: Row = {};
  let markerSource: unknown = null;

  if (Array.isArray(parsed)) {
    markerSource = parsed;
  } else if (isRow(parsed)) {
    obj = parsed;
    if (obj.type === "FeatureCollection") {
      return fromGeoJson(obj);
    }
    markerSource = obj.markers ?? obj.points ?? obj.locations ?? obj.places ?? obj.pins ?? obj.stops ?? obj.data;
  }

  const markers: MapMarker[] = [];
  if (Array.isArray(markerSource)) {
    for (const item of markerSource.slice(0, 300)) {
      const marker = markerFrom(item);
      if (marker) {
        markers.push(marker);
      }
    }
  }

  const routeRaw = obj.route ?? obj.path ?? obj.line;
  let route: [number, number][] | null = null;
  let numbered = false;
  if (routeRaw === true && markers.length >= 2) {
    route = markers.map((marker) => [marker.lat, marker.lng] as [number, number]);
    numbered = true;
  } else if (Array.isArray(routeRaw)) {
    const coords = routeRaw
      .slice(0, 2000)
      .map((point) => coordPair(point))
      .filter((point): point is [number, number] => point !== null);
    if (coords.length >= 2) {
      route = coords;
    }
  }

  if (markers.length === 0 && !route) {
    return null;
  }

  const zoomNum = coerceNumber(obj.zoom);
  return {
    title: textField(obj.title),
    markers,
    route,
    numbered,
    center: coordPair(obj.center),
    zoom: zoomNum !== null && zoomNum >= 1 && zoomNum <= 19 ? Math.round(zoomNum) : null,
  };
}

/** Serializes a map spec into a downloadable GeoJSON FeatureCollection. */
export function mapSpecToGeoJson(spec: MapSpec): string {
  const features: Record<string, unknown>[] = spec.markers.map((marker) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [marker.lng, marker.lat] },
    properties: {
      ...(marker.label ? { name: marker.label } : {}),
      ...(marker.description ? { description: marker.description } : {}),
    },
  }));
  if (spec.route && spec.route.length >= 2) {
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: spec.route.map(([lat, lng]) => [lng, lat]),
      },
      properties: { name: spec.title ?? "Route" },
    });
  }
  return JSON.stringify({ type: "FeatureCollection", features }, null, 2);
}
