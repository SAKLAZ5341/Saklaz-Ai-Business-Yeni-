import _sodium from "libsodium-wrappers-sumo";

/**
 * libsodium örneği. Kriptografik işlemlerden önce bir kez `initCrypto()` çağrılmalıdır.
 * Kendi kripto primitiflerimizi YAZMIYORUZ (SECURITY.md §14); her şey libsodium üzerinden yapılır.
 */
let instance: typeof _sodium | undefined;

export async function initCrypto(): Promise<void> {
  if (instance) return;
  await _sodium.ready;
  instance = _sodium;
}

export function sodium(): typeof _sodium {
  if (!instance) {
    throw new Error("Kripto katmanı başlatılmadı: önce initCrypto() çağrılmalı.");
  }
  return instance;
}
