export { canonicalize, canonicalBytes, CanonicalJsonError, type JsonValue } from "./jcs.js";
export { ProtocolError, type ProtocolErrorCode } from "./errors.js";
export * from "./schemas.js";
export {
  buildHeader,
  signInnerMessage,
  parseInnerMessage,
  verifyInnerMessageSignature,
  encodeInnerMessage,
  decodeInnerMessage,
  messageSigningBytes,
  uuidv7,
  MAX_INNER_MESSAGE_BYTES,
  type HeaderInput,
} from "./message.js";
export {
  ReplayGuard,
  MemoryReplayStore,
  checkTiming,
  REPLAY_WINDOW,
  CLOCK_SKEW_MS,
  type ReplayStore,
  type ReplayState,
  type ReplayVerdict,
} from "./replay.js";
export {
  ApprovalLedger,
  MemoryApprovalStore,
  computeApprovalDigest,
  approvalDigestInput,
  approvalSigningBytes,
  verifyApprovalRequestDigest,
  signApprovalDecision,
  DEFAULT_APPROVAL_TTL_SEC,
  type ApprovalContext,
  type ApprovalStore,
  type PendingApproval,
} from "./approval.js";
export {
  IncomingVerifier,
  ROLE_PERMISSIONS,
  type DeviceRole,
  type VerifierPolicy,
  type VerifyOptions,
  type Verified,
} from "./verifier.js";
export {
  RosterLog,
  RosterError,
  RosterEntrySchema,
  RosterDeviceSchema,
  applyRosterEntry,
  rosterEntryHash,
  linkRole,
  signRosterEntry,
  cosignRosterEntry,
  LINK_ROLES,
  ROSTER_GENESIS_PREV,
  type RosterDevice,
  type RosterEntry,
  type RosterHead,
  type RosterOp,
  type RosterState,
  type LinkRole,
  type EntryDraft,
} from "./roster.js";
export { E2EChannel, E2EError, type E2EOptions, type ReceiveResult, type WireKind, type WireOut } from "./e2e.js";
export {
  ClientFrameSchema,
  ServerFrameSchema,
  WIRE_KINDS,
  relayAuthPayload,
  type ClientFrame,
  type ServerFrame,
} from "./relay-wire.js";
