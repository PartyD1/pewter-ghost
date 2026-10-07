/**
 * G-29 static dashboard: DashboardMetrics -> one self-contained HTML file
 * (inline SVG charts, no scripts, no server). Every chart has its numbers in a
 * table under it, native SVG <title> tooltips on every mark, and light/dark
 * themes from the same tokens.
 *
 *   npx tsx eval/src/cli.ts dashboard --logs proxy/.data/logs --recordings proxy/.data/recordings --levels levels/saved
 */
import type { DashboardMetrics, Rate } from "./metrics";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (r: number) => `${(r * 100).toFixed(0)}%`;
const rateText = (r: Rate) => (r.n ? `${pct(r.rate)} (${r.hits}/${r.n})` : "no data");

interface Bar {
  label: string;
  value: number;
  /** Tooltip text. */
  tip: string;
  /** Muted (no data). */
  empty?: boolean;
}

const W = 520;
const H = 200;
const PAD = { l: 40, r: 12, t: 12, b: 34 };

function axisY(max: number, fmt: (v: number) => string): string {
  const out: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const v = (max * i) / 4;
    const y = PAD.t + (H - PAD.t - PAD.b) * (1 - i / 4);
    out.push(`<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`);
    out.push(`<text class="tick" x="${PAD.l - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${esc(fmt(v))}</text>`);
  }
  return out.join("");
}

/** Vertical bars from a common baseline. `max` defaults to 1 (rates). */
export function barChart(title: string, bars: readonly Bar[], o: { max?: number; fmt?: (v: number) => string; series?: 1 | 2 } = {}): string {
  const max = o.max ?? 1;
  const fmt = o.fmt ?? pct;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const slot = bars.length ? iw / bars.length : iw;
  const bw = Math.max(4, Math.min(48, slot - 6));
  const marks = bars
    .map((b, i) => {
      const h = max > 0 ? Math.max(0, Math.min(1, b.value / max)) * ih : 0;
      const x = PAD.l + i * slot + (slot - bw) / 2;
      const y = PAD.t + ih - h;
      const r = Math.min(4, bw / 2, h);
      // Rounded top, square base on the baseline.
      const path =
        h <= 0
          ? ""
          : `<path class="bar s${o.series ?? 1}" d="M${x.toFixed(1)},${(PAD.t + ih).toFixed(1)} V${(y + r).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + r).toFixed(1)},${y.toFixed(1)} H${(x + bw - r).toFixed(1)} Q${(x + bw).toFixed(1)},${y.toFixed(1)} ${(x + bw).toFixed(1)},${(y + r).toFixed(1)} V${(PAD.t + ih).toFixed(1)} Z"/>`;
      const hit = `<rect class="hit" x="${(PAD.l + i * slot).toFixed(1)}" y="${PAD.t}" width="${slot.toFixed(1)}" height="${ih}"><title>${esc(b.tip)}</title></rect>`;
      const label = `<text class="tick${b.empty ? " muted" : ""}" x="${(x + bw / 2).toFixed(1)}" y="${H - PAD.b + 16}" text-anchor="middle">${esc(b.label)}</text>`;
      return path + label + hit;
    })
    .join("");
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${axisY(max, fmt)}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}"/>${marks}</svg></figure>`;
}

/** A line over x (numeric) with markers. */
export function lineChart(title: string, pts: readonly { x: number; y: number; tip: string }[], o: { xLabel?: string; max?: number } = {}): string {
  const max = o.max ?? 1;
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const xs = pts.map((p) => p.x);
  const x0 = xs.length ? Math.min(...xs) : 0;
  const x1 = xs.length ? Math.max(...xs) : 1;
  const sx = (x: number) => PAD.l + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
  const sy = (y: number) => PAD.t + ih * (1 - Math.max(0, Math.min(1, y / max)));
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  const marks = pts
    .map((p) => `<circle class="dot" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="4"/><circle class="hit" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="12"><title>${esc(p.tip)}</title></circle>`)
    .join("");
  const xticks = pts.map((p) => `<text class="tick" x="${sx(p.x).toFixed(1)}" y="${H - PAD.b + 16}" text-anchor="middle">${p.x}</text>`).join("");
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${axisY(max, pct)}<line class="axis" x1="${PAD.l}" x2="${W - PAD.r}" y1="${H - PAD.b}" y2="${H - PAD.b}"/>${pts.length ? `<path class="line" d="${d}"/>` : ""}${marks}${xticks}${o.xLabel ? `<text class="tick" x="${W - PAD.r}" y="${H - 4}" text-anchor="end">${esc(o.xLabel)}</text>` : ""}</svg></figure>`;
}

/** counts[y][x] heatmap, y up (leniency), x right (linearity). Sequential one-hue ramp. */
export function heatmap(title: string, counts: readonly (readonly number[])[], o: { xLabel: string; yLabel: string }): string {
  const bins = counts.length;
  const size = 200;
  const cell = size / Math.max(1, bins);
  const max = Math.max(1, ...counts.flat());
  const ramp = ["--seq-0", "--seq-1", "--seq-2", "--seq-3", "--seq-4"];
  const cells: string[] = [];
  for (let yi = 0; yi < bins; yi++)
    for (let xi = 0; xi < bins; xi++) {
      const c = counts[yi][xi];
      const step = c === 0 ? 0 : Math.min(4, 1 + Math.floor(((c - 1) / max) * 4));
      const x = 30 + xi * cell;
      const y = 10 + (bins - 1 - yi) * cell;
      cells.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cell - 2).toFixed(1)}" height="${(cell - 2).toFixed(1)}" rx="2" style="fill:var(${ramp[step]})"><title>${esc(`${o.xLabel} ${(xi / bins).toFixed(1)}-${((xi + 1) / bins).toFixed(1)}, ${o.yLabel} ${(yi / bins).toFixed(1)}-${((yi + 1) / bins).toFixed(1)}: ${c} level(s)`)}</title></rect>`,
      );
    }
  return `<figure class="heat"><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 250 245" role="img" aria-label="${esc(title)}">${cells.join("")}<text class="tick" x="130" y="232" text-anchor="middle">${esc(o.xLabel)} 0 to 1</text><text class="tick" x="12" y="110" text-anchor="middle" transform="rotate(-90 12 110)">${esc(o.yLabel)} 0 to 1</text></svg></figure>`;
}

function table(head: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  return `<details><summary>Table</summary><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(String(c))}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></details>`;
}

function tile(label: string, value: string, note = ""): string {
  return `<div class="tile"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div>${note ? `<div class="tn">${esc(note)}</div>` : ""}</div>`;
}

const STYLE = `
:root{color-scheme:light;--surface:#fcfcfb;--panel:#ffffff;--border:#e4e3df;--text:#0b0b0b;--text2:#52514e;--muted:#8a8984;
--s1:#2a78d6;--s2:#eb6834;--seq-0:#f0efec;--seq-1:#b7d3f6;--seq-2:#6da7ec;--seq-3:#2a78d6;--seq-4:#184f95}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--surface:#1a1a19;--panel:#222220;--border:#383835;--text:#ffffff;--text2:#c3c2b7;--muted:#8f8e86;
--s1:#3987e5;--s2:#d95926;--seq-0:#2c2c2a;--seq-1:#184f95;--seq-2:#256abf;--seq-3:#3987e5;--seq-4:#86b6ef}}
:root[data-theme="dark"]{color-scheme:dark;--surface:#1a1a19;--panel:#222220;--border:#383835;--text:#ffffff;--text2:#c3c2b7;--muted:#8f8e86;
--s1:#3987e5;--s2:#d95926;--seq-0:#2c2c2a;--seq-1:#184f95;--seq-2:#256abf;--seq-3:#3987e5;--seq-4:#86b6ef}
*{box-sizing:border-box}body{margin:0;background:var(--surface);color:var(--text);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
p.sub{color:var(--text2);margin:0 0 16px}.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.tile{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px 12px}.tl{color:var(--text2);font-size:12px}.tv{font-size:22px;font-weight:600}.tn{color:var(--muted);font-size:12px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}
figure{margin:0;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:10px}figcaption{font-weight:600;margin-bottom:6px}
svg{width:100%;height:auto;display:block}.grid{stroke:var(--border);stroke-width:1}.axis{stroke:var(--muted);stroke-width:1}
.tick{fill:var(--text2);font-size:11px}.muted{fill:var(--muted)}.bar.s1{fill:var(--s1)}.bar.s2{fill:var(--s2)}
.line{fill:none;stroke:var(--s1);stroke-width:2}.dot{fill:var(--s1);stroke:var(--panel);stroke-width:2}.hit{fill:transparent}.hit:hover{fill:var(--text);fill-opacity:.06}
details{margin-top:6px}summary{cursor:pointer;color:var(--text2);font-size:12px}table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}
th,td{text-align:left;padding:3px 6px;border-bottom:1px solid var(--border)}th{color:var(--text2);font-weight:600}
.wrap{overflow-x:auto}.note{color:var(--muted);font-size:12px}`;

export interface DashboardOptions {
  title?: string;
  /** Shown in the header; omit for deterministic output (tests). */
  generatedAt?: string;
}

export function renderDashboard(m: DashboardMetrics, o: DashboardOptions = {}): string {
  const title = o.title ?? "Pewter Ghost dogfood dashboard";
  const parts: string[] = [];
  parts.push(`<h1>${esc(title)}</h1>`);
  parts.push(
    `<p class="sub">${m.sessions.length} session(s), ${m.ghosts} ghost(s) shown${o.generatedAt ? `, generated ${esc(o.generatedAt)}` : ""}. Lab members are not students: read these as development signals.</p>`,
  );

  parts.push(`<div class="tiles">${[
    tile("Acceptance", rateText(m.acceptance), "accepted + partial of ended ghosts"),
    tile("Drawn over", rateText(m.drawnOver), "falling within a session is good"),
    tile("Verified first try", rateText(m.verifiedFirstTry), "answers passing with no send-back"),
    tile("Send-back pass", rateText(m.sendBackPass)),
    tile("Dropped for time", rateText(m.dropForTime), "target under 10%"),
    tile("Dropped by verifier", rateText(m.dropForVerify)),
    tile("Latency p50 / p90", m.latency.n ? `${Math.round(m.latency.p50)} / ${Math.round(m.latency.p90)} ms` : "no data"),
    tile("Hand repair in 60 s", rateText(m.handRepair), m.handRepairUnknown ? `${m.handRepairUnknown} accepted without a recording` : "first study: 68%"),
    tile("Patterns per session", m.sessions.length ? m.patternsPerSession.toFixed(1) : "no data", `target 5 or more; ${m.patternRuns3} run(s) of 3`),
    ...(m.survey ? [tile("Gave an idea", rateText(m.survey.ideaYes), `${m.survey.answers} answer(s)`)] : []),
  ].join("")}</div>`);

  // Acceptance by kind and band.
  const kinds = (["finish", "extend", "fix"] as const).map((k) => ({ k, r: m.byKind[k] }));
  parts.push(`<h2>Acceptance</h2><div class="grid2">`);
  parts.push(
    `<div>${barChart(
      "Acceptance by kind",
      kinds.map(({ k, r }) => ({ label: k, value: r.rate, empty: !r.n, tip: `${k}: ${rateText(r)}` })),
    )}${table(
      ["kind", "ended", "accepted", "rate", "outcomes"],
      kinds.map(({ k, r }) => [k, r.n, r.hits, r.n ? pct(r.rate) : "-", Object.entries(r.outcomes).map(([o2, n]) => `${o2} ${n}`).join(", ")]),
    )}</div>`,
  );
  parts.push(
    `<div>${barChart(
      "Acceptance by confidence band",
      m.byBand.map((b) => ({ label: `${b.band} ${b.lo}-${b.hi}`, value: b.r.rate, empty: !b.r.n, tip: `${b.band} [${b.lo}, ${b.hi}): ${rateText(b.r)}` })),
    )}${table(["band", "range", "ended", "accepted", "rate"], m.byBand.map((b) => [b.band, `${b.lo}-${b.hi}`, b.r.n, b.r.hits, b.r.n ? pct(b.r.rate) : "-"]))}</div>`,
  );
  const hi = m.byBand[2].r;
  const lo = m.byBand[0].r;
  parts.push(`</div><p class="note">Calibration target (G-27): high-band acceptance at least 1.5x the low band. Now: ${hi.n && lo.n && lo.rate > 0 ? `${(hi.rate / lo.rate).toFixed(2)}x` : "not enough data"}.</p>`);
  parts.push(
    `<div class="grid2"><div>${barChart(
      "Acceptance by stated confidence (0.1 bins)",
      m.byConfidence.map((b) => ({ label: b.lo.toFixed(1), value: b.r.rate, empty: !b.r.n, tip: `${b.lo.toFixed(1)}-${b.hi.toFixed(1)}: ${rateText(b.r)}` })),
    )}${table(["confidence", "ended", "accepted", "rate"], m.byConfidence.map((b) => [`${b.lo.toFixed(1)}-${b.hi.toFixed(1)}`, b.r.n, b.r.hits, b.r.n ? pct(b.r.rate) : "-"]))}</div>`,
  );
  parts.push(
    `<div>${lineChart(
      "Drawn-over rate by minute of session",
      m.drawnOverByMinute.map((p) => ({ x: p.minute, y: p.r.rate, tip: `minute ${p.minute}: ${rateText(p.r)}` })),
      { xLabel: "minute" },
    )}${table(["minute", "ended", "drawn over", "rate"], m.drawnOverByMinute.map((p) => [p.minute, p.r.n, p.r.hits, pct(p.r.rate)]))}</div></div>`,
  );

  // Calls.
  parts.push(`<h2>Calls and verification</h2><div class="grid2">`);
  parts.push(
    `<div>${barChart("Verification and drops", [
      { label: "first try", value: m.verifiedFirstTry.rate, empty: !m.verifiedFirstTry.n, tip: `verified first try: ${rateText(m.verifiedFirstTry)}` },
      { label: "send-back", value: m.sendBackPass.rate, empty: !m.sendBackPass.n, tip: `send-back pass: ${rateText(m.sendBackPass)}` },
      { label: "drop: time", value: m.dropForTime.rate, empty: !m.dropForTime.n, tip: `dropped for time: ${rateText(m.dropForTime)}` },
      { label: "drop: verify", value: m.dropForVerify.rate, empty: !m.dropForVerify.n, tip: `dropped by verifier: ${rateText(m.dropForVerify)}` },
    ])}</div>`,
  );
  const lat = m.latency;
  parts.push(
    `<div>${barChart(
      "Latency of answered calls",
      [
        { label: "p50", value: lat.p50, tip: `p50 ${Math.round(lat.p50)} ms` },
        { label: "p90", value: lat.p90, tip: `p90 ${Math.round(lat.p90)} ms` },
        { label: "p99", value: lat.p99, tip: `p99 ${Math.round(lat.p99)} ms` },
        { label: "budget", value: lat.budgetMs, tip: `call budget ${lat.budgetMs} ms` },
      ],
      { max: Math.max(lat.budgetMs, lat.p99, 1) * 1.1, fmt: (v) => `${Math.round(v)}` },
    )}<p class="note">${lat.n} answered call(s); ${pct(lat.withinBudget)} within the ${lat.budgetMs} ms budget.</p></div></div>`,
  );

  // Sessions and patterns.
  parts.push(`<h2>Sessions</h2>`);
  parts.push(
    barChart(
      "Distinct patterns in accepted ghosts per session",
      m.sessions.map((s) => ({ label: s.sessionId.slice(0, 10), value: s.patterns.length, tip: `${s.sessionId}: ${s.patterns.join(", ") || "none"}` })),
      { max: Math.max(5, ...m.sessions.map((s) => s.patterns.length)), fmt: (v) => v.toFixed(0) },
    ),
  );
  parts.push(
    `<div class="wrap">${table(
      ["session", "filler", "model", "prompt", "minutes", "shown", "accepted", "drawn over", "patterns", "saves", "beatable at end"],
      m.sessions.map((s) => [s.sessionId, s.filler, s.model, s.promptVersion, s.minutes.toFixed(1), s.shown, s.accepted, s.drawnOver, s.patterns.join(", ") || "-", s.saves, s.beatableAtEnd === null ? "?" : s.beatableAtEnd ? "yes" : "no"]),
    ).replace("<details>", "<details open>")}</div>`,
  );

  // Levels.
  parts.push(`<h2>Saved levels (measure package)</h2>`);
  if (!m.levels.length) parts.push(`<p class="note">No saved levels given (--levels).</p>`);
  else {
    parts.push(`<div class="grid2">`);
    for (const g of m.levels)
      parts.push(
        `<div>${heatmap(`Expressive range: ${g.group} (${g.levels} levels)`, g.range.counts, { xLabel: "linearity", yLabel: "leniency" })}<p class="note">coverage ${pct(g.range.coverage)}</p></div>`,
      );
    parts.push(`</div>`);
    parts.push(
      table(
        ["group", "levels", "diversity (mean pairwise distance)", "mean difficulty", "max difficulty", "distinct patterns per level"],
        m.levels.map((g) => [g.group, g.levels, g.diversity.toFixed(3), g.meanDifficulty.toFixed(3), g.maxDifficulty.toFixed(3), g.meanDistinctPatterns.toFixed(1)]),
      ).replace("<details>", "<details open>"),
    );
  }

  if (m.survey) {
    parts.push(`<h2>Session questions</h2>`);
    parts.push(
      table(
        ["session", "gave an idea", "how did it feel", "what annoyed you"],
        m.survey.notes.map((a) => [a.sessionId, a.idea === undefined ? "-" : a.idea ? "yes" : "no", a.feel ?? "", a.annoyed ?? ""]),
      ).replace("<details>", "<details open>"),
    );
  }

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ghost Dogfood Dashboard</title><style>${STYLE}</style></head>
<body><main>
${parts.join("\n")}
</main></body></html>
`;
}
