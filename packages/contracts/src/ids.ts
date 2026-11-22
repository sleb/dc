import { z } from "zod";

export const GameIdSchema = z.string().regex(/^[A-Za-z0-9]{20}$/);
export const PlayerIdSchema = z.string().regex(/^p_[a-z2-7]{8}$/);
export const CardIdSchema = z.string().regex(/^c_[a-z0-9]{10}$/);
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
export const RoomCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[BCDFGHJKLMNPQRSTVWXZ]{4}$/);

export type GameId = z.infer<typeof GameIdSchema>;
export type PlayerId = z.infer<typeof PlayerIdSchema>;
export type CardId = z.infer<typeof CardIdSchema>;
export type SubmissionId = CardId;
export type Uid = string;
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;
