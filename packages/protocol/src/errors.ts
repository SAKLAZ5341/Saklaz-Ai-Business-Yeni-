/**
 * Protokol düzeyi hata kodları. Ajan bu kodları denetim kaydına yazar; gönderene yalnızca
 * ayrıntısız bir ret döner (FAZ1-PLAN §4.4).
 */
export type ProtocolErrorCode =
  | "SCHEMA_INVALID"
  | "UNSUPPORTED_VERSION"
  | "UNKNOWN_SENDER"
  | "WRONG_RECIPIENT"
  | "WRONG_WORKSPACE"
  | "BEFORE_RESTORE_FLOOR"
  | "ROSTER_BEHIND"
  | "ROSTER_FORK"
  | "SIGNATURE_INVALID"
  | "REPLAY_COUNTER"
  | "TS_IN_FUTURE"
  | "MESSAGE_EXPIRED"
  | "EXPIRY_TOO_LONG"
  | "ROLE_FORBIDDEN"
  | "APPROVAL_UNKNOWN"
  | "APPROVAL_USED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_MISMATCH"
  | "APPROVAL_WRONG_SIGNER"
  | "APPROVAL_NOT_GRANTED"
  | "EXECUTION_PARAMS_CHANGED";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  constructor(code: ProtocolErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ProtocolError";
    this.code = code;
  }
}
