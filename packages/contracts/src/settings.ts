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

/** The full settings object (LLD 1 `Settings`); every key present. */
export const SettingsSchema = z.object({
  targetOverride: TargetOverrideSchema,
  profanity: ProfanitySchema,
  variants: VariantsSchema,
  spectators: SpectatorsSchema,
  writeCountsOverride: WriteCountsOverrideSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;

/** Every key optional; nested objects are complete or absent (LLD 1 replaces them wholesale; never merged). */
export const SettingsPatchSchema = SettingsSchema.partial();
export type SettingsPatch = z.infer<typeof SettingsPatchSchema>;
