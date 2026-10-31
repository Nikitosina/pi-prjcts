import { Type, type TObject } from "typebox";

/** Providers need root object fields; keep the union for action-specific validation before execution. */
export function objectUnion<T extends TObject[]>(variants: [...T]) {
  const names = new Set(variants.flatMap((variant) => Object.keys(variant.properties)));
  const properties = Object.fromEntries(
    [...names].map((name) => [
      name,
      Type.Union(variants.flatMap((variant) => (variant.properties[name] ? [variant.properties[name]] : []))),
    ]),
  );
  const required = (variants[0]?.required ?? []).filter((name) => variants.every((variant) => variant.required?.includes(name)));
  return Type.Union(variants, { type: "object", properties, required });
}
