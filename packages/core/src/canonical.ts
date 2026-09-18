/**
 * Canonical JSON of a JSON text, the text spec/conformance/check.py compares:
 * `json.dumps(json.loads(text), sort_keys=True, separators=(",", ":"))`. A
 * repeated key keeps its last value, and a number with a fraction or an
 * exponent is formatted as Python's `repr` formats it, so `1` and `1.0` stay
 * distinct. Only for comparing records, the tie-break core.md 4 recommends,
 * and never written to the wire. Read once, iteratively, so a line nested as
 * deep as `JSON.parse` allows cannot overflow the stack.
 */

const STRING = /"[^"\\]*(?:\\.[^"\\]*)*"/y;
const NUMBER = /-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;

interface Container {
  /** Key and canonical value; `undefined` for an array. */
  members: Array<[string, string]> | undefined;
  items: string[];
  /** The key the object's next value goes under, once read. */
  key: string | undefined;
}

/** `text` must be JSON `JSON.parse` accepts. `omit` drops top-level keys. */
export function canonical(text: string, omit?: ReadonlySet<string>): string {
  const open: Container[] = [];
  let result = "";
  const put = (value: string): void => {
    const top = open[open.length - 1];
    if (top === undefined) result = value;
    else if (top.members === undefined) top.items.push(value);
    else {
      top.members.push([top.key as string, value]);
      top.key = undefined;
    }
  };
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    switch (c) {
      case 0x20:
      case 0x09:
      case 0x0a:
      case 0x0d:
      case 0x2c: // ,
      case 0x3a: // :
        i++;
        break;
      case 0x7b: // {
        open.push({ members: [], items: [], key: undefined });
        i++;
        break;
      case 0x5b: // [
        open.push({ members: undefined, items: [], key: undefined });
        i++;
        break;
      case 0x7d: {
        // }
        const members = (open.pop() as Container).members as Array<[string, string]>;
        members.sort((a, b) => byCodePoint(a[0], b[0]));
        const skip = open.length === 0 ? omit : undefined;
        let body = "";
        for (let j = 0; j < members.length; j++) {
          const [key, value] = members[j] as [string, string];
          // Stable sort: a repeated key's last value wins, like json.loads.
          if ((j + 1 < members.length && (members[j + 1] as [string, string])[0] === key) || skip?.has(key) === true) continue;
          body += (body === "" ? "" : ",") + pyString(key) + ":" + value;
        }
        put("{" + body + "}");
        i++;
        break;
      }
      case 0x5d: // ]
        put("[" + (open.pop() as Container).items.join(",") + "]");
        i++;
        break;
      case 0x22: {
        STRING.lastIndex = i;
        STRING.test(text);
        const token = text.slice(i, STRING.lastIndex);
        i = STRING.lastIndex;
        const s = token.includes("\\") ? (JSON.parse(token) as string) : token.slice(1, -1);
        const top = open[open.length - 1];
        if (top?.members !== undefined && top.key === undefined) top.key = s;
        else put(pyString(s));
        break;
      }
      case 0x74:
        put("true");
        i += 4;
        break;
      case 0x66:
        put("false");
        i += 5;
        break;
      case 0x6e:
        put("null");
        i += 4;
        break;
      default: {
        NUMBER.lastIndex = i;
        const m = NUMBER.exec(text) as RegExpExecArray;
        i = NUMBER.lastIndex;
        put(m[1] === undefined && m[2] === undefined ? BigInt(m[0]).toString() : pyFloat(Number(m[0])));
      }
    }
  }
  return result;
}

/** Order by code point, as Python compares strings, not by UTF-16 unit. */
export function byCodePoint(a: string, b: string): number {
  for (let i = 0; i < a.length && i < b.length; ) {
    const x = a.codePointAt(i) as number;
    const y = b.codePointAt(i) as number;
    if (x !== y) return x - y;
    i += x > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

const ESCAPES: Readonly<Record<number, string>> = { 0x22: '\\"', 0x5c: "\\\\", 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x08: "\\b", 0x0c: "\\f" };

/** A string as `json.dumps` writes it with `ensure_ascii`. */
function pyString(s: string): string {
  let out = '"';
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e && c !== 0x22 && c !== 0x5c) continue;
    out += s.slice(from, i) + (ESCAPES[c] ?? "\\u" + c.toString(16).padStart(4, "0"));
    from = i + 1;
  }
  return out + s.slice(from) + '"';
}

/** As Python's `repr`: shortest round-trip digits, exponent past 1e-4/1e16. */
function pyFloat(x: number): string {
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const [mantissa = "", exponent = ""] = Math.abs(x).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const e = Number(exponent);
  let out: string;
  if (e < -4 || e >= 16) {
    out = (digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits) + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
  } else if (e < 0) {
    out = "0." + "0".repeat(-e - 1) + digits;
  } else if (digits.length <= e + 1) {
    out = digits + "0".repeat(e + 1 - digits.length) + ".0";
  } else {
    out = digits.slice(0, e + 1) + "." + digits.slice(e + 1);
  }
  return x < 0 ? "-" + out : out;
}
