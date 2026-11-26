// #30 A7 (PJ15): the key order of every doc is the order of the strict contracts schema, recursively, so `JSON.stringify` is canonical. The schema is walked through its zod 4 definitions
// (`_zod.def`), duck-typed: the engine package does not depend on zod. Objects are checked in declaration order; a discriminated union is resolved by its tag; optional keys may be absent;
// records ascend. One documented exception: in the three `live` audiences the tag `audience` leads (the projector spreads the shared base after it, as built since 2.2 and pinned by the goldens);
// the `departed` view keeps `kind` before `audience`, as declared.
interface Def { type: string; shape?: Record<string, Zod>; element?: Zod; innerType?: Zod; options?: Zod[]; discriminator?: string; valueType?: Zod; values?: unknown[] }
interface Zod { _zod: { def: Def } }
const def = (s: Zod): Def => s._zod.def;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function leadingKey(shape: Record<string, Zod>): string | null {
  const kind = shape.kind === undefined ? undefined : def(shape.kind).values?.[0];
  return kind === "live" && shape.audience !== undefined ? "audience" : null;
}

function pick(options: readonly Zod[], tag: string, value: Record<string, unknown>): Zod | undefined {
  return options.find((o) => { const t = def(o).shape?.[tag]; return t !== undefined && def(t).values?.includes(value[tag]) === true; });
}

function ascending(a: string, b: string): boolean {
  const na = Number(a);
  const nb = Number(b);
  return Number.isInteger(na) && Number.isInteger(nb) ? na < nb : a < b;
}

/** Where `value` is out of schema order, one line per object: its path, the keys it has and the keys in the order the schema declares them. Empty when canonical. */
export function keyOrderViolations(value: unknown, schema: unknown, path = ""): string[] {
  const out: string[] = [];
  const at = path === "" ? "(root)" : path;
  const s = schema as Zod;
  const d = def(s);
  if (d.type === "nullable" || d.type === "optional") return value === null || value === undefined || d.innerType === undefined ? out : keyOrderViolations(value, d.innerType, path);
  if (d.type === "array") {
    if (Array.isArray(value) && d.element !== undefined) value.forEach((v, i) => out.push(...keyOrderViolations(v, d.element, `${path}[${i}]`)));
    return out;
  }
  if (d.type === "union") {
    if (!isObject(value) || d.options === undefined) return out;
    const tag = d.discriminator;
    const option = tag === undefined ? d.options.find((o) => def(o).type === "object") : pick(d.options, tag, value);
    return option === undefined ? out : keyOrderViolations(value, option, path);
  }
  if (d.type === "record") {
    if (!isObject(value)) return out;
    const keys = Object.keys(value);
    for (let i = 1; i < keys.length; i++) if (!ascending(keys[i - 1] as string, keys[i] as string)) { out.push(`${at}: record keys [${keys.join(",")}] are not ascending`); break; }
    if (d.valueType !== undefined) for (const [k, v] of Object.entries(value)) out.push(...keyOrderViolations(v, d.valueType, `${path}.${k}`));
    return out;
  }
  if (d.type === "object" && d.shape !== undefined && isObject(value)) {
    const lead = leadingKey(d.shape);
    const declared = Object.keys(d.shape);
    const expected = lead === null ? declared : [lead, ...declared.filter((k) => k !== lead)];
    const have = Object.keys(value).filter((k) => expected.includes(k));
    const want = expected.filter((k) => Object.hasOwn(value, k));
    if (have.join() !== want.join()) out.push(`${at}: keys [${have.join(",")}] expected [${want.join(",")}]`);
    for (const [k, sub] of Object.entries(d.shape)) if (Object.hasOwn(value, k)) out.push(...keyOrderViolations(value[k], sub, path === "" ? k : `${path}.${k}`));
  }
  return out;
}

/** The M-keyorder transform: every object's keys in reverse order, arrays and values untouched. Shape-valid (same keys, same values), so only a key-order check can see it. */
export function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (isObject(value)) return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)])) as T;
  return value;
}
