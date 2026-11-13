export { AgentCore, newDeviceKeys, type AgentOptions, type IncomingFrame, type ProcessResult } from "./core.js";
export { AuditLog, type AuditRecord, type AuditAction } from "./audit.js";
export { Lockdown, type LocalAuthenticator, type LockdownInfo } from "./lockdown.js";
export { RollbackGuard, type RollbackStatus } from "./rollback.js";
export { MemoryVault, InsecureFileVault, type SecretVault } from "./vault.js";
export { openAgentDb, getMeta, setMeta, type AgentDb } from "./db.js";
export { RelayClient, ttlFor, type RelayClientOptions } from "./transport.js";
export { KeyProtectionError, PROTECTOR_IDS, type KeyProtector, type KeyProtectionErrorCode, type ProtectorBinding, type ProtectorKind } from "./protectors/types.js";
export { DpapiUserProtector } from "./protectors/dpapi.js";
export { ProtectedKeyStore, bindingHash, defaultKeyPath, KEK_BYTES } from "./keystore.js";
// MVP alfa: servis, şifreli dosya kasası, izinli komutlar
export { AgentService, openVault, profileDir, validateRelayUrl, isProfile, PROFILES, type Profile, type ProfileConfig, type ServiceOptions } from "./app/service.js";
export { EncryptedFileVault, VaultError } from "./app/filevault.js";
export { runCommand, helpText, allowedCommandNames, type CommandResult } from "./app/commands.js";
