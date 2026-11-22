import { z } from "zod";

// Pieces shared by the command envelope and the view schemas.
export const VariantsSchema = z.object({
  pitch: z.boolean(), writeIn: z.boolean(), redraw: z.boolean(), peoplesChoice: z.boolean(),
});
export const SpectatorsSchema = z.object({ enabled: z.boolean(), vote: z.boolean() });
export const TargetOverrideSchema = z.number().int().min(2).max(10).nullable();
export const ProfanitySchema = z.enum(["on", "off"]);
export const WriteCountsOverrideSchema = z
  .object({ red: z.number().int().min(0).max(10), green: z.number().int().min(0).max(10) })
  .nullable();

/** Nested objects are complete or absent (LLD 1 replaces them wholesale; never merged). */
export const SettingsPatchSchema = z.object({
  targetOverride: TargetOverrideSchema.optional(),
  profanity: ProfanitySchema.optional(),
  variants: VariantsSchema.optional(),
  spectators: SpectatorsSchema.optional(),
  writeCountsOverride: WriteCountsOverrideSchema.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
export type Settings = Required<SettingsPatch>;
