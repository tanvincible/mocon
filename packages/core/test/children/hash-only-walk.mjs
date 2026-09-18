// Child of hash-only.test.ts, run with `node --import tsx` under a small
// heap. Captures one program-shaped value under a `hash-only` rule and
// prints the input Payload it recorded.
import { memorySink, mocon } from "../../src/index.ts";

const values = {
  plain: () => ({ a: [1, 2, 3] }),
  sparse: () => new Array(2 ** 32 - 1),
  selfNesting: () => ({
    toJSON() {
      return { a: this };
    },
  }),
  growing: () => {
    const list = [];
    const item = {
      toJSON() {
        list.push(item);
        return 1;
      },
    };
    list.push(item);
    return list;
  },
};

const make = values[process.argv[2]];
if (make === undefined) throw new Error(`unknown case ${process.argv[2]}`);
const sink = memorySink();
const m = mocon({ host: "h", capabilities: { observes_crossings: "all" }, sinks: [sink], capture: { rules: { "crossing.input": "hash-only" } } });
const ex = m.execution.start({ program: "p", notice: false });
ex.crossing.start({ target: "t", input: make(), notice: true });
process.stdout.write(JSON.stringify(JSON.parse(sink.lines.at(-1)).input) + "\n");
