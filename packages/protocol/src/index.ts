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
  type PairedPhone,
  type PeerDirectory,
  type VerifierPolicy,
  type Verified,
} from "./verifier.js";
