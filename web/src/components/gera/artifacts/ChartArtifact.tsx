import { BarChart3, Braces, Download } from "lucide-react";
import { memo, useMemo, useRef, useState, type ReactElement } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  CHART_COLORS,
  coerceNumber,
  downloadSvgElement,
  parseChartSpec,
  slugify,
  type ChartSpec,
} from "@/lib/artifacts";

import { ArtifactLightbox, ArtifactShell, ShellCopyButton, ShellExpandButton, ShellIconButton } from "./ArtifactShell";
import { CodeBlock } from "./CodeBlock";

const MARGIN = { top: 10, right: 16, bottom: 4, left: 4 };
const GRID_STROKE = "hsl(336, 10%, 82%)";
const AXIS_TICK = { fontSize: 11, fill: "hsl(332, 8%, 42%)" };
const TOOLTIP_STYLE = {
  background: "hsl(338, 30%, 98%)",
  border: "1px solid hsl(336, 10%, 80%)",
  borderRadius: 12,
  fontSize: 12,
  boxShadow: "0 10px 28px -16px rgba(35, 20, 28, 0.4)",
};

const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fullFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function formatTick(value: unknown): string {
  return typeof value === "number" ? compactFormat.format(value) : String(value);
}

function tooltipValue(value: unknown): string {
  if (typeof value === "number") {
    return fullFormat.format(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => tooltipValue(item)).join(" – ");
  }
  return String(value);
}

/**
 * Renders a ```chart fence as an interactive recharts card with a
 * streaming skeleton, SVG download, and a raw-data toggle.
 */
export const ChartArtifact = memo(function ChartArtifact({ code, streaming }: { code: string; streaming: boolean }) {
  const spec = useMemo(() => parseChartSpec(code), [code]);
  const [showData, setShowData] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  if (!spec) {
    if (streaming) {
      return <ChartSkeleton />;
    }
    return (
      <ArtifactShell icon={BarChart3} title="Chart" badge="invalid spec" actions={<ShellCopyButton text={code} />}>
        <p className="border-b border-border/60 px-3.5 py-2 text-xs text-destructive">
          Could not read this chart spec — showing the raw JSON.
        </p>
        <CodeBlock code={code} language="json" frameless />
      </ArtifactShell>
    );
  }

  const title = spec.title ?? "Chart";

  const handleDownload = () => {
    const svg = containerRef.current?.querySelector("svg");
    if (svg) {
      downloadSvgElement(svg, `${slugify(title)}.svg`);
    }
  };

  return (
    <ArtifactShell
      icon={BarChart3}
      title={title}
      badge={spec.kind}
      actions={
        <>
          <ShellIconButton
            icon={Braces}
            label={showData ? "Hide data" : "View data"}
            active={showData}
            onClick={() => setShowData((value) => !value)}
          />
          <ShellExpandButton onClick={() => setExpanded(true)} />
          <ShellIconButton icon={Download} label="Download SVG" onClick={handleDownload} />
          <ShellCopyButton text={code} />
        </>
      }
    >
      <div ref={containerRef} className="px-2 pb-1 pt-3">
        <ResponsiveContainer width="100%" height={320}>
          <ChartBody spec={spec} />
        </ResponsiveContainer>
      </div>
      {showData ? <CodeBlock code={code} language="json" frameless /> : null}
      <ArtifactLightbox open={expanded} onOpenChange={setExpanded} icon={BarChart3} title={title} badge={spec.kind}>
        <div className="h-full w-full p-4 sm:p-6">
          <ResponsiveContainer width="100%" height="100%">
            <ChartBody spec={spec} />
          </ResponsiveContainer>
        </div>
      </ArtifactLightbox>
    </ArtifactShell>
  );
});

function ChartBody({
  spec,
  width,
  height,
}: {
  spec: ChartSpec;
  width?: number;
  height?: number;
}): ReactElement {
  const grid = <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />;
  const xAxis = <XAxis dataKey={spec.xKey} tick={AXIS_TICK} tickLine={false} axisLine={false} minTickGap={18} />;
  const yAxis = <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} width={46} tickFormatter={formatTick} />;
  const legend =
    spec.series.length > 1 || spec.kind === "pie" || spec.kind === "donut" ? (
      <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} />
    ) : null;
  const tooltip = (
    <Tooltip
      contentStyle={TOOLTIP_STYLE}
      labelStyle={{ color: "hsl(330, 15%, 13%)", fontWeight: 600 }}
      formatter={(value) => tooltipValue(value)}
      cursor={spec.kind === "bar" ? { fill: "hsl(333 45% 33% / 0.07)" } : undefined}
    />
  );

  switch (spec.kind) {
    case "bar": {
      const categorical = spec.series.length === 1 && spec.data.length <= 10;
      return (
        <BarChart data={spec.data} margin={MARGIN} width={width} height={height}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {spec.series.map((series) => (
            <Bar
              key={series.key}
              dataKey={series.key}
              name={series.label}
              fill={series.color}
              radius={spec.stacked ? undefined : ([6, 6, 0, 0] as [number, number, number, number])}
              maxBarSize={44}
              stackId={spec.stacked ? "stack" : undefined}
              animationDuration={600}
            >
              {categorical
                ? spec.data.map((_, index) => <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />)
                : null}
            </Bar>
          ))}
        </BarChart>
      );
    }
    case "area":
      return (
        <AreaChart data={spec.data} margin={MARGIN} width={width} height={height}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {spec.series.map((series) => (
            <Area
              key={series.key}
              type="monotone"
              dataKey={series.key}
              name={series.label}
              stroke={series.color}
              strokeWidth={2.2}
              fill={series.color}
              fillOpacity={0.16}
              stackId={spec.stacked ? "stack" : undefined}
              animationDuration={600}
            />
          ))}
        </AreaChart>
      );
    case "pie":
    case "donut": {
      const valueKey = spec.series[0].key;
      return (
        <PieChart width={width} height={height}>
          {tooltip}
          {legend}
          <Pie
            data={spec.data}
            dataKey={valueKey}
            nameKey={spec.xKey}
            innerRadius={spec.kind === "donut" ? "52%" : 0}
            outerRadius="82%"
            paddingAngle={spec.kind === "donut" ? 2 : 1}
            stroke="hsl(338, 30%, 98%)"
            strokeWidth={2}
            animationDuration={600}
          >
            {spec.data.map((_, index) => (
              <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      );
    }
    case "radar":
      return (
        <RadarChart data={spec.data} width={width} height={height} cx="50%" cy="50%" outerRadius="72%">
          <PolarGrid stroke={GRID_STROKE} />
          <PolarAngleAxis dataKey={spec.xKey} tick={AXIS_TICK} />
          <PolarRadiusAxis tick={false} axisLine={false} />
          {tooltip}
          {legend}
          {spec.series.map((series) => (
            <Radar
              key={series.key}
              name={series.label}
              dataKey={series.key}
              stroke={series.color}
              fill={series.color}
              fillOpacity={0.2}
              strokeWidth={2}
              animationDuration={600}
            />
          ))}
        </RadarChart>
      );
    case "scatter":
      return (
        <ScatterChart margin={MARGIN} width={width} height={height}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis
            type="number"
            dataKey="x"
            name={spec.xKey}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            tickFormatter={formatTick}
            domain={["auto", "auto"]}
          />
          <YAxis
            type="number"
            dataKey="y"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={46}
            tickFormatter={formatTick}
          />
          <Tooltip
            contentStyle={TOOLTIP_STYLE}
            cursor={{ strokeDasharray: "3 3" }}
            formatter={(value) => tooltipValue(value)}
          />
          {legend}
          {spec.series.map((series) => {
            const points = spec.data
              .map((row) => ({ x: coerceNumber(row[spec.xKey]), y: coerceNumber(row[series.key]) }))
              .filter((point): point is { x: number; y: number } => point.x !== null && point.y !== null);
            return <Scatter key={series.key} name={series.label} data={points} fill={series.color} animationDuration={600} />;
          })}
        </ScatterChart>
      );
    default:
      return (
        <LineChart data={spec.data} margin={MARGIN} width={width} height={height}>
          {grid}
          {xAxis}
          {yAxis}
          {tooltip}
          {legend}
          {spec.series.map((series) => (
            <Line
              key={series.key}
              type="monotone"
              dataKey={series.key}
              name={series.label}
              stroke={series.color}
              strokeWidth={2.4}
              dot={spec.data.length <= 30 ? { r: 2.5, strokeWidth: 0, fill: series.color } : false}
              activeDot={{ r: 4.5 }}
              animationDuration={600}
            />
          ))}
        </LineChart>
      );
  }
}

function ChartSkeleton() {
  const heights = [52, 78, 40, 88, 64, 30, 72];
  return (
    <div className="gera-artifact my-3 overflow-hidden rounded-2xl border border-border/80 bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/70 bg-foreground/[0.03] px-3.5 py-2">
        <BarChart3 className="h-3.5 w-3.5 text-ember" />
        <span className="text-xs font-medium text-muted-foreground">Drawing chart…</span>
      </div>
      <div className="flex h-[220px] items-end gap-3 px-6 pb-6 pt-8">
        {heights.map((height, index) => (
          <div
            key={index}
            className="flex-1 animate-pulse rounded-t-lg bg-ember/15"
            style={{ height: `${height}%`, animationDelay: `${index * 120}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
