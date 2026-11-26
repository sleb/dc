// The revision of the projector's output (LLD 2 8.2). Bump it with any change that alters a view for the same state, and pin the new golden fingerprint in
// `test/project/rev-pins.json` in the same change: `test/project/rev.test.ts` fails on a changed corpus without a bump and on a bump without a pin. Only ever increases.
export const PROJECTOR_REV = 1;
