// #30 TY1 to TY4 (LLD 2 11.6): type-level guards, checked by `bun run typecheck` (tsconfig.test.json). A guard that cannot fail proves nothing, so each is repeated under @ts-expect-error over a deliberately leaky type.
import type { GameView, RoundDoc, ViewDoc } from "@dc/contracts";
import type { Game, Player, Round, Submission } from "../../src/types";
import type { Assignable, DeepKeys, Equal, Expect, Not } from "./types-support";

type Live = Extract<GameView, { kind: "live" }>;
type PlayerPublic = Live["players"][number];
type RoundPublic = NonNullable<Live["round"]>;
type RevealCard = NonNullable<RoundPublic["reveal"]>[number];
type Secret = "scorePile" | "pools" | "cards" | "drafts" | "submissions" | "revealOrder" | "hostId" | "uid" | "seed" | "episode";

// TY1: a raw aggregate is not a view
export type TY1a = Expect<Not<Assignable<Game, GameView>>>;
export type TY1b = Expect<Not<Assignable<Player, PlayerPublic>>>;
export type TY1c = Expect<Not<Assignable<Round, RoundPublic>>>;
export type TY1d = Expect<Not<Assignable<Submission, RevealCard>>>;

// TY2: no secret key anywhere in a view, a stored doc or a round doc
export type TY2a = Expect<Equal<Extract<DeepKeys<GameView>, Secret>, never>>;
export type TY2b = Expect<Equal<Extract<DeepKeys<ViewDoc>, Secret>, never>>;
export type TY2c = Expect<Equal<Extract<DeepKeys<RoundDoc>, Secret>, never>>;

// TY3: enums cannot drift between the contracts and the engine
export type TY3a = Expect<Equal<GameView["audience"], "spectator" | "host" | "player" | "departed">>;
export type TY3b = Expect<Equal<Live["phase"], Game["phase"]>>;
export type TY3c = Expect<Equal<PlayerPublic["status"], Player["status"]>>;
export type TY3d = Expect<Equal<RoundPublic["phase"], Round["phase"]>>;

// TY4: negative controls. A deliberately leaky view type must trip every guard above.
interface LeakyPlayer extends PlayerPublic { uid: string; hand: string[] }
interface LeakyView { audience: "spectator"; players: LeakyPlayer[]; pools: Game["pools"]; nested: { revealOrder: string[] }[] }
// @ts-expect-error TY2 must see `uid`, `pools` and `revealOrder` in a leaky type
export type TY4a = Expect<Equal<Extract<DeepKeys<LeakyView>, Secret>, never>>;
// @ts-expect-error TY1 must flag a Player that is assignable to the public shape
export type TY4b = Expect<Not<Assignable<Player & PlayerPublic, PlayerPublic>>>;
// @ts-expect-error TY3 must flag a drifted enum
export type TY4c = Expect<Equal<"LOBBY" | "WRITING", Game["phase"]>>;
// @ts-expect-error TY3 must flag a missing audience
export type TY4d = Expect<Equal<"spectator" | "host" | "player", GameView["audience"]>>;
