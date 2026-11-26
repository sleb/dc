// #30: the type-level vocabulary of types.test-d.ts. Types only.
export type Assignable<A, B> = [A] extends [B] ? true : false;
export type Expect<T extends true> = T;
export type Not<T extends boolean> = T extends true ? false : true;
/** Strict equality: `Equal<A, B>` is true only for the same type, not for mutually assignable ones. */
export type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Every property name reachable from `T`, through objects, arrays and unions, to any depth. */
export type DeepKeys<T> = T extends readonly (infer U)[] ? DeepKeys<U> : T extends object ? { [K in keyof T & string]: K | DeepKeys<T[K]> }[keyof T & string] : never;
