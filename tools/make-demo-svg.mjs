#!/usr/bin/env node
// Renders assets/demo.svg — the animated terminal shown at the top of the README.
//
// The transcript below is recorded from a real `omp-route explain` run against a
// stub OMP that speaks the same JSON contract as the real CLI, so the demo never
// shows output the tool could not actually produce.
//
//   node tools/make-demo-svg.mjs

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const C = {
  bg: "#0D1117",
  chrome: "#161B22",
  border: "#30363D",
  text: "#E6EDF3",
  dim: "#7D8590",
  green: "#00E676",
  cyan: "#00E5FF",
  violet: "#A78BFA",
  amber: "#F5A524",
  red: "#FF5F57",
  yellow: "#FEBC2E",
  lime: "#28C840",
};

const command = "omp-route explain cctq-claude/claude-fable-5 --prefer cursor,cctq-claude,openrouter";

// [delay in seconds, spans] — spans are [text, color] pairs.
const lines = [
  [2.30, [["Generated 1 fallback route.", C.dim]]],
  [2.60, []],
  [2.80, [["source: ", C.dim], ["cctq-claude/claude-fable-5", C.text], [" (claude-fable@5)", C.violet]]],
  [3.30, [["  1. ", C.amber], ["cursor/claude-fable-5", C.cyan], [" — preference #1, 100% quota remaining", C.dim]]],
  [3.80, [["  2. ", C.amber], ["openrouter/anthropic/claude-fable-5", C.cyan], [" — preference #3, quota unknown", C.dim]]],
  [4.30, [["  3. ", C.amber], ["glm-fireworks/anthropic/claude-fable-5", C.cyan], [" — quota unknown", C.dim]]],
];

const LOOP = 14; // seconds
const FONT = 14;
const LINE_H = 22;
const PAD_X = 22;
const TOP = 74;
const WIDTH = 840;
const HEIGHT = TOP + LINE_H * (lines.length + 3) + 26;
const CHAR_W = FONT * 0.6;

const pct = (seconds) => `${((seconds / LOOP) * 100).toFixed(3)}%`;
const esc = (value) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const keyframes = [];
const rules = [];

// Each element keeps one shared 14s duration and encodes its own timing in the
// keyframe percentages, so nothing drifts out of sync across loop iterations.
const revealAt = (name, at) => {
  keyframes.push(`@keyframes ${name}{0%,${pct(at)}{opacity:0}${pct(at + 0.16)},92%{opacity:1}98%,100%{opacity:0}}`);
  rules.push(`.${name}{opacity:0;animation:${name} ${LOOP}s steps(1,end) infinite}`);
};

const typeAt = (name, at, duration) => {
  keyframes.push(
    `@keyframes ${name}{0%,${pct(at)}{transform:translateX(0)}${pct(at + duration)},92%{transform:translateX(${
      command.length * CHAR_W + 12
    }px)}98%,100%{transform:translateX(0)}}`,
  );
  rules.push(`.${name}{animation:${name} ${LOOP}s steps(${command.length},end) infinite}`);
};

const body = [];

// Prompt + typed command.
revealAt("p0", 0.25);
body.push(
  `<text class="p0" x="${PAD_X}" y="${TOP}" font-size="${FONT}">` +
    `<tspan fill="${C.green}" font-weight="700">$ </tspan>` +
    `<tspan fill="${C.text}">${esc(command)}</tspan></text>`,
);
typeAt("type", 0.4, 1.7);
body.push(
  `<rect class="type" x="${PAD_X + 2 * CHAR_W}" y="${TOP - FONT}" width="${command.length * CHAR_W + 16}" height="${
    FONT + 8
  }" fill="${C.bg}" />`,
);

lines.forEach(([at, spans], index) => {
  if (spans.length === 0) return;
  const name = `l${index}`;
  revealAt(name, at);
  const tspans = spans.map(([text, fill]) => `<tspan fill="${fill}">${esc(text)}</tspan>`).join("");
  body.push(
    `<text class="${name}" x="${PAD_X}" y="${TOP + LINE_H * (index + 1.4)}" font-size="${FONT}" xml:space="preserve">${tspans}</text>`,
  );
});

// Trailing prompt with a blinking block cursor.
const lastY = TOP + LINE_H * (lines.length + 1.9);
revealAt("p1", 5.5);
body.push(
  `<text class="p1" x="${PAD_X}" y="${lastY}" font-size="${FONT}" font-weight="700" fill="${C.green}">$</text>`,
);
keyframes.push(`@keyframes blink{0%,${pct(5.5)}{opacity:0}${pct(5.6)},92%{opacity:1}92.5%,100%{opacity:0}}`);
keyframes.push("@keyframes flash{0%,49%{opacity:1}50%,100%{opacity:0}}");
rules.push(`.cursor{opacity:0;animation:blink ${LOOP}s steps(1,end) infinite,flash 1.06s steps(1,end) infinite}`);
body.push(
  `<rect class="cursor" x="${PAD_X + 2 * CHAR_W}" y="${lastY - FONT + 2}" width="${CHAR_W}" height="${FONT}" fill="${C.green}" />`,
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Terminal recording of omp-route explain producing a ranked fallback chain">
  <title>omp-route explain — ranked fallback chain</title>
  <defs>
    <style>
      text{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
      ${keyframes.join("\n      ")}
      ${rules.join("\n      ")}
      @media (prefers-reduced-motion:reduce){*{animation:none!important;opacity:1!important;transform:none!important}.type{display:none}}
    </style>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${C.green}" stop-opacity="0.55" />
      <stop offset="50%" stop-color="${C.cyan}" stop-opacity="0.35" />
      <stop offset="100%" stop-color="${C.violet}" stop-opacity="0.55" />
    </linearGradient>
  </defs>

  <rect x="0.75" y="0.75" width="${WIDTH - 1.5}" height="${HEIGHT - 1.5}" rx="10" fill="${C.bg}" stroke="url(#edge)" stroke-width="1.5" />
  <path d="M0.75 10.75a10 10 0 0 1 10-10h${WIDTH - 21.5}a10 10 0 0 1 10 10V38H0.75z" fill="${C.chrome}" />
  <line x1="0.75" y1="38" x2="${WIDTH - 0.75}" y2="38" stroke="${C.border}" />
  <circle cx="22" cy="19.5" r="5.5" fill="${C.red}" />
  <circle cx="41" cy="19.5" r="5.5" fill="${C.yellow}" />
  <circle cx="60" cy="19.5" r="5.5" fill="${C.lime}" />
  <text x="${WIDTH / 2}" y="24" text-anchor="middle" font-size="12" fill="${C.dim}">omp-route — routing plan compiler</text>

  ${body.join("\n  ")}
</svg>
`;

await mkdir(path.join(root, "assets"), { recursive: true });
await writeFile(path.join(root, "assets", "demo.svg"), svg, "utf8");
console.log(`assets/demo.svg written (${svg.length} bytes, ${LOOP}s loop)`);
