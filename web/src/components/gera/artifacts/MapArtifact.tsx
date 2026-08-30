import { Braces, Download, MapPin } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { Map as LeafletMapInstance } from "leaflet";

import {
  downloadText,
  mapSpecToGeoJson,
  parseMapSpec,
  slugify,
  type MapMarker,
  type MapSpec,
} from "@/lib/artifacts";
import { cn } from "@/lib/utils";

import { ArtifactLightbox, ArtifactShell, ShellCopyButton, ShellExpandButton, ShellIconButton } from "./ArtifactShell";
import { CodeBlock } from "./CodeBlock";

const ACCENT = "hsl(333, 45%, 33%)";
const PAPER = "#FBF8FA";

/** Mulberry teardrop pin as an inline SVG; numbered variant for routes. */
function pinHtml(num: number | null): string {
  const inner =
    num === null
      ? `<circle cx="14" cy="13.5" r="5" fill="${PAPER}"/>`
      : `<circle cx="14" cy="13.5" r="8" fill="${PAPER}"/><text x="14" y="17" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="10" font-weight="700" fill="${ACCENT}">${num}</text>`;
  return `<svg width="28" height="36" viewBox="0 0 28 36" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(35,20,28,0.35));"><path d="M14 0C6.27 0 0 6.27 0 14c0 10.4 14 22 14 22s14-11.6 14-22C28 6.27 21.73 0 14 0z" fill="${ACCENT}"/>${inner}</svg>`;
}

/** Builds popup content with DOM APIs so model text can never inject HTML. */
function popupNode(marker: MapMarker): HTMLElement {
  const root = document.createElement("div");
  root.style.minWidth = "140px";
  root.style.maxWidth = "220px";
  if (marker.label) {
    const title = document.createElement("p");
    title.textContent = marker.label;
    title.style.margin = "0";
    title.style.fontSize = "13px";
    title.style.fontWeight = "600";
    root.appendChild(title);
  }
  if (marker.description) {
    const desc = document.createElement("p");
    desc.textContent = marker.description;
    desc.style.margin = "4px 0 0";
    desc.style.fontSize = "12px";
    desc.style.color = "#6E5D67";
    root.appendChild(desc);
  }
  const link = document.createElement("a");
  link.href = `https://www.google.com/maps?q=${marker.lat},${marker.lng}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = `${marker.lat.toFixed(5)}, ${marker.lng.toFixed(5)} ↗`;
  link.style.display = "inline-block";
  link.style.marginTop = "6px";
  link.style.fontSize = "11px";
  link.style.color = ACCENT;
  root.appendChild(link);
  return root;
}

/**
 * Renders a ```map / ```geojson fence as an interactive Leaflet map with
 * mulberry pins, popups, optional route polyline, and GeoJSON download.
 * Leaflet is lazy-loaded so it never weighs down chats without maps.
 */
export const MapArtifact = memo(function MapArtifact({ code, streaming }: { code: string; streaming: boolean }) {
  const spec = useMemo(() => parseMapSpec(code), [code]);
  const [showData, setShowData] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);

  if (!spec) {
    if (streaming) {
      return <MapSkeleton />;
    }
    return (
      <ArtifactShell icon={MapPin} title="Map" badge="invalid spec" actions={<ShellCopyButton text={code} />}>
        <p className="border-b border-border/60 px-3.5 py-2 text-xs text-destructive">
          Could not read this map spec — showing the raw JSON.
        </p>
        <CodeBlock code={code} language="json" frameless />
      </ArtifactShell>
    );
  }

  const title = spec.title ?? "Map";
  const count = spec.markers.length;
  const badge = spec.route
    ? `${count > 0 ? `${count} stops · ` : ""}route`
    : `${count} pin${count === 1 ? "" : "s"}`;

  return (
    <ArtifactShell
      icon={MapPin}
      title={title}
      badge={badge}
      actions={
        <>
          <ShellIconButton
            icon={Braces}
            label={showData ? "Hide data" : "View data"}
            active={showData}
            onClick={() => setShowData((value) => !value)}
          />
          <ShellExpandButton onClick={() => setExpanded(true)} />
          <ShellIconButton
            icon={Download}
            label="Download GeoJSON"
            onClick={() => downloadText(`${slugify(title)}.geojson`, mapSpecToGeoJson(spec), "application/geo+json")}
          />
          <ShellCopyButton text={code} />
        </>
      }
    >
      <MapCanvas spec={spec} />
      {showData ? <CodeBlock code={code} language="json" frameless /> : null}
      <ArtifactLightbox open={expanded} onOpenChange={setExpanded} icon={MapPin} title={title} badge={badge}>
        <div className="h-full w-full">
          <MapCanvas spec={spec} fill />
        </div>
      </ArtifactLightbox>
    </ArtifactShell>
  );
});

function MapCanvas({ spec, fill = false }: { spec: MapSpec; fill?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<boolean>(false);
  const specKey = useMemo(() => JSON.stringify(spec), [spec]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }
    const current = JSON.parse(specKey) as MapSpec;
    let map: LeafletMapInstance | null = null;
    let observer: ResizeObserver | null = null;
    let cancelled = false;
    setReady(false);
    setLoadError(false);

    const onMouseLeave = () => {
      map?.scrollWheelZoom.disable();
    };

    (async () => {
      try {
        const mod = await import("leaflet");
        await import("leaflet/dist/leaflet.css");
        if (cancelled || !containerRef.current) {
          return;
        }
        const L = (mod as unknown as { default?: typeof mod }).default ?? mod;

        const instance = L.map(el, {
          scrollWheelZoom: false,
          zoomControl: true,
          attributionControl: true,
        });
        map = instance;

        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>',
        }).addTo(instance);

        current.markers.forEach((marker, index) => {
          const icon = L.divIcon({
            className: "gera-map-pin",
            html: pinHtml(current.numbered ? index + 1 : null),
            iconSize: [28, 36],
            iconAnchor: [14, 34],
            popupAnchor: [0, -32],
          });
          L.marker([marker.lat, marker.lng], { icon }).addTo(instance).bindPopup(popupNode(marker));
        });

        if (current.route && current.route.length >= 2) {
          L.polyline(current.route, {
            color: ACCENT,
            weight: 3,
            opacity: 0.85,
            dashArray: "6 8",
            lineCap: "round",
            lineJoin: "round",
          }).addTo(instance);
        }

        const points: [number, number][] = [
          ...current.markers.map((marker) => [marker.lat, marker.lng] as [number, number]),
          ...(current.route ?? []),
        ];
        if (current.center) {
          instance.setView(current.center, current.zoom ?? 11);
        } else if (points.length === 1) {
          instance.setView(points[0], current.zoom ?? 13);
        } else if (points.length > 1) {
          instance.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: current.zoom ?? 15 });
        } else {
          instance.setView([20, 0], 2);
        }

        instance.on("click", () => {
          instance.scrollWheelZoom.enable();
        });
        el.addEventListener("mouseleave", onMouseLeave);

        observer = new ResizeObserver(() => {
          instance.invalidateSize();
        });
        observer.observe(el);

        instance.whenReady(() => {
          if (!cancelled) {
            setReady(true);
          }
        });
      } catch {
        if (!cancelled) {
          setLoadError(true);
        }
      }
    })();

    return () => {
      cancelled = true;
      el.removeEventListener("mouseleave", onMouseLeave);
      observer?.disconnect();
      map?.remove();
      map = null;
    };
  }, [specKey]);

  return (
    <div
      className={cn(
        "relative isolate w-full overflow-hidden bg-[#E9E1E6]",
        fill ? "h-full min-h-[320px]" : "h-[360px]",
      )}
    >
      <div ref={containerRef} className="h-full w-full" />
      {!ready && !loadError ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="rounded-full bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm">
            Loading map…
          </span>
        </div>
      ) : null}
      {loadError ? (
        <div className="absolute inset-0 grid place-items-center bg-card">
          <span className="px-4 text-center text-xs text-destructive">
            Map library failed to load. Check your connection and try again.
          </span>
        </div>
      ) : null}
    </div>
  );
}

const SKELETON_PINS: { top: string; left: string; delay: number }[] = [
  { top: "26%", left: "30%", delay: 0 },
  { top: "48%", left: "58%", delay: 160 },
  { top: "64%", left: "38%", delay: 320 },
  { top: "34%", left: "72%", delay: 480 },
];

function MapSkeleton() {
  return (
    <div className="gera-artifact my-3 overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/70 bg-foreground/[0.03] px-3.5 py-2">
        <MapPin className="h-3.5 w-3.5 text-ember" />
        <span className="text-xs font-medium text-muted-foreground">Plotting map…</span>
      </div>
      <div className="relative h-[220px] bg-[#E9E1E6]">
        <div className="absolute inset-x-0 top-1/3 h-px bg-foreground/10" />
        <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/10" />
        {SKELETON_PINS.map((pin, index) => (
          <span
            key={index}
            className="absolute h-3 w-3 animate-pulse rounded-full bg-ember/40"
            style={{ top: pin.top, left: pin.left, animationDelay: `${pin.delay}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
