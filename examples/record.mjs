/**
 * Regenerates the terminal animation on the front page from a REAL run of `server.mjs`, so the
 * picture cannot drift from what the code does:
 *
 *   node examples/server.mjs > /tmp/mocon.out
 *   node examples/record.mjs
 *   npx svg-term-cli --in /tmp/mocon.cast --out docs/src/assets/demo.svg \
 *     --window --width 100 --height 26 --padding 16
 *
 * Nothing here invents output. It only decides how long each line stays before the next one lands,
 * because the run itself takes a quarter of a second and nobody can read that.
 */

import fs from "node:fs";

const ESC = String.fromCharCode(27);
const lines = fs.readFileSync("/tmp/mocon.out", "utf8").split("\n").filter((l) => l.length);

/** How long to sit on a line before the next one arrives, by what the line is. */
function pause(line) {
  const bare = line.replace(/\x1b\[[0-9;]*m/g, "");
  if (/^[│ ]+$/.test(bare)) return 0.2; //                      a spacer, not something to read
  if (bare.includes("↳")) return 1.5; //                        the truncation note: the whole point
  if (/^[├└]─/.test(bare)) return 0.85; //                      a tool call starting
  if (/(args|result|error)\s{2}/.test(bare)) return 0.7; //     a captured payload
  return 1.1; //                                                the execution header
}

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

for (const l of lines.slice(2)) {
  t += pause(l);
  push(l + "\r\n");
}

// Hold the finished trace on screen. This is the frame anyone actually reads, and because the
// animation loops it is the only chance to. svg-term ends at the LAST EVENT, so an empty pause is
// dropped and the loop would snap back the instant the prompt appears: these anchor the tail.
t += 3.0;
push(prompt);
t += 2.0;
push(ESC + "[0m");
t += 2.0;
push(ESC + "[0m");

const header = {
  version: 2,
  width: 100,
  height: lines.length + 5,
  timestamp: 0,
  env: { TERM: "xterm-256color", SHELL: "/bin/zsh" },
};
fs.writeFileSync("/tmp/mocon.cast", [JSON.stringify(header), ...ev.map((e) => JSON.stringify(e))].join("\n") + "\n");
console.log(`cast: ${ev.length} events, ${t.toFixed(1)}s total, ${lines.length} output lines, ${header.height} rows`);
