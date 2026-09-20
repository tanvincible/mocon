/**
 * Regenerates the terminal animation on the front page from a REAL run of `server.mjs`, so the
 * picture cannot drift from what the code does:
 *
 *   node examples/server.mjs > /tmp/mocon.out
 *   node examples/record.mjs
 *   npx svg-term-cli --in /tmp/mocon.cast --out docs/src/assets/demo.svg \
 *     --window --width 94 --height 14 --padding 16
 *
 * Nothing here invents output. It only decides how long each line stays before the next one lands,
 * because the run itself takes a quarter of a second and nobody can read that.
 */

import fs from "node:fs";

const ESC = String.fromCharCode(27);
const lines = fs.readFileSync("/tmp/mocon.out", "utf8").split("\n").filter((l) => l.length);

const ev = [];
let t = 0.6;
const push = (s) => ev.push([Number(t.toFixed(3)), "o", s]);
const prompt = ESC + "[32m$" + ESC + "[0m ";

push(prompt);
for (const ch of "node server.mjs") {
  t += 0.085;
  push(ch);
}
t += 0.9;
push("\r\n");

// The server comes up, then waits a beat before a request arrives.
push(lines[0] + "\r\n");
t += 1.6;
push(lines[1] + "\r\n");
t += 0.9;
push("\r\n");

// The run. Slow enough to read each line before the next arrives, and slower still on the
// header lines, which carry the declaration nobody reads at speed.
const body = lines.slice(2);
for (const [i, l] of body.entries()) {
  t += i < 3 ? 1.15 : 0.95;
  push(l + "\r\n");
}

// Hold the finished tree on screen. This is the frame anyone actually reads, and the loop
// makes it the only chance to.
t += 5.5;
push(prompt);
// svg-term ends the animation at the LAST EVENT, so a trailing pause with nothing in it is
// dropped and the loop snaps back the instant the prompt appears. These anchor the tail.
t += 1.5;
push(ESC + "[0m");
t += 1.5;
push(ESC + "[0m");

const header = {
  version: 2,
  width: 94,
  height: lines.length + 5,
  timestamp: 0,
  env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
};
fs.writeFileSync("/tmp/mocon.cast", [JSON.stringify(header), ...ev.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`cast: ${ev.length} events, ${t.toFixed(1)}s total, ${lines.length} output lines, ${header.height} rows`);
