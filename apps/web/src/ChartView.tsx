import { getLocale } from "./i18n";
import { shortNumber, ticks, type ChartSpec } from "./chart";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
/** Series colours: the accent first, then colours that stay apart in both themes. */
const COLORS = ["var(--accent)", "#7fd6a4", "#f0b37e", "#e88fb4", "#7cc7e8", "#c3a6ff", "#e8d27c", "#a9a9b0"];

/**
 * Draws a chart from an answer as SVG (bar, line or pie), with a legend and the numbers as a table under it.
 *
 * @param props.spec - The chart ({@link parseChart}).
 */
export function ChartView({ spec }: { spec: ChartSpec }) {
  const W = 560;
  const H = 260;
  const pad = { l: 44, r: 12, t: 12, b: 34 };
  const all = spec.series.flatMap((s) => s.values);
  const unit = spec.unit ?? "";
  const label = `${spec.title ? `${spec.title}: ` : ""}${L("גרף", "chart")} ${spec.type}`;
  let body: React.ReactNode;
  if (spec.type === "pie") {
    const values = spec.series[0]!.values.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0) || 1;
    let at = -Math.PI / 2;
    const cx = W / 2;
    const cy = H / 2;
    const r = H / 2 - 16;
    body = values.map((v, i) => {
      const a = (v / total) * Math.PI * 2;
      const x1 = cx + r * Math.cos(at);
      const y1 = cy + r * Math.sin(at);
      at += a;
      const x2 = cx + r * Math.cos(at);
      const y2 = cy + r * Math.sin(at);
      const d = a >= Math.PI * 2 - 1e-6 ? `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0` : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${a > Math.PI ? 1 : 0} 1 ${x2} ${y2} Z`;
      return <path key={i} d={d} fill={COLORS[i % COLORS.length]} stroke="var(--bg)" strokeWidth="2"><title>{`${spec.labels[i]}: ${shortNumber(v)}${unit} (${Math.round((v / total) * 100)}%)`}</title></path>;
    });
  } else {
    const t = ticks(Math.min(...all), Math.max(...all));
    const lo = t[0]!;
    const hi = t.at(-1)!;
    const x0 = pad.l;
    const w = W - pad.l - pad.r;
    const h = H - pad.t - pad.b;
    const y = (v: number) => pad.t + h - ((v - lo) / (hi - lo || 1)) * h;
    const n = spec.labels.length;
    const slot = w / n;
    const every = Math.max(1, Math.ceil(n / 8));
    const grid = t.map((v) => (
      <g key={`g${v}`}>
        <line x1={x0} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
        <text x={x0 - 6} y={y(v) + 4} textAnchor="end" className="chart-axis">{shortNumber(v)}</text>
      </g>
    ));
    const xs = spec.labels.map((l, i) => (i % every === 0 ? <text key={`x${i}`} x={x0 + slot * (i + 0.5)} y={H - 12} textAnchor="middle" className="chart-axis">{l.length > 10 ? `${l.slice(0, 9)}…` : l}</text> : null));
    const marks =
      spec.type === "bar"
        ? spec.series.flatMap((s, si) => {
            const bw = Math.max(2, (slot * 0.72) / spec.series.length);
            return s.values.map((v, i) => {
              const top = y(Math.max(0, v));
              const bottom = y(Math.min(0, v));
              return <rect key={`b${si}-${i}`} x={x0 + slot * i + slot * 0.14 + bw * si} y={top} width={bw - 1} height={Math.max(1, bottom - top)} rx="2" fill={COLORS[si % COLORS.length]}><title>{`${s.name ? `${s.name} · ` : ""}${spec.labels[i]}: ${shortNumber(v)}${unit}`}</title></rect>;
            });
          })
        : spec.series.map((s, si) => (
            <g key={`s${si}`}>
              <polyline fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth="2.5" strokeLinejoin="round" points={s.values.map((v, i) => `${x0 + slot * (i + 0.5)},${y(v)}`).join(" ")} />
              {n <= 30 && s.values.map((v, i) => <circle key={i} cx={x0 + slot * (i + 0.5)} cy={y(v)} r="3.5" fill={COLORS[si % COLORS.length]}><title>{`${s.name ? `${s.name} · ` : ""}${spec.labels[i]}: ${shortNumber(v)}${unit}`}</title></circle>)}
            </g>
          ));
    body = <>{grid}{marks}{xs}</>;
  }
  const legend = spec.type === "pie" ? spec.labels.map((l, i) => ({ name: l, color: COLORS[i % COLORS.length]! })) : spec.series.filter((s) => s.name).map((s, i) => ({ name: s.name, color: COLORS[i % COLORS.length]! }));
  return (
    <figure className="chart-view">
      {spec.title && <figcaption dir="auto">{spec.title}</figcaption>}
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} style={{ direction: "ltr" }}>{body}</svg>
      {legend.length > 0 && (
        <div className="chart-legend" dir="auto">
          {legend.map((x) => <span key={x.name}><i style={{ background: x.color }} />{x.name}</span>)}
        </div>
      )}
      <details className="small">
        <summary>{L("המספרים", "The numbers")}</summary>
        <table className="md-table">
          <thead><tr><th />{spec.series.map((s, i) => <th key={i}>{s.name || L("ערך", "Value")}</th>)}</tr></thead>
          <tbody>{spec.labels.map((l, i) => <tr key={i}><td dir="auto">{l}</td>{spec.series.map((s, si) => <td key={si}>{`${s.values[i]}${unit}`}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
