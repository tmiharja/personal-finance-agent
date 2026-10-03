import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Envelope encryption (PRD §7.1).
 *
 *   MASTER_KEY (env, 32 bytes) ──wraps──▶ per-user data key (DEK, stored wrapped in user_keys)
 *   DEK ──HKDF──▶ field key (AES-256-GCM) + dedupe key (HMAC-SHA256)
 *
 * Ciphertexts are bound to their user and field through AES-GCM additional data,
 * so a value copied into another user's row or another column fails to decrypt.
 * Formats (base64url parts, dot-separated):
 *   wrapped DEK: k<masterKeyId>.<iv>.<ciphertext>.<tag>
 *   field value: v1.<iv>.<ciphertext>.<tag>
 */

const ALG = "aes-256-gcm";
const IV_BYTES = 12;

export type MasterKeys = {
  current: { id: number; key: Buffer };
  previous?: { id: number; key: Buffer };
};

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

export function parseKey(base64: string, name: string): Buffer {
  const key = Buffer.from(base64, "base64");
  if (key.length !== 32) throw new Error(`${name} must be base64 of exactly 32 bytes`);
  return key;
}

export function masterKeysFromEnv(env: {
  MASTER_KEY?: string;
  MASTER_KEY_ID: number;
  MASTER_KEY_PREVIOUS?: string;
}): MasterKeys {
  if (!env.MASTER_KEY) throw new Error("MASTER_KEY is not set");
  return {
    current: { id: env.MASTER_KEY_ID, key: parseKey(env.MASTER_KEY, "MASTER_KEY") },
    previous: env.MASTER_KEY_PREVIOUS
      ? { id: env.MASTER_KEY_ID - 1, key: parseKey(env.MASTER_KEY_PREVIOUS, "MASTER_KEY_PREVIOUS") }
      : undefined,
  };
}

function seal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${b64(iv)}.${b64(ct)}.${b64(cipher.getAuthTag())}`;
}

function open(key: Buffer, sealed: string, aad: string): Buffer {
  const [iv, ct, tag] = sealed.split(".");
  if (!iv || !ct || tag === undefined) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv(ALG, key, unb64(iv));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(unb64(tag));
  return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]);
}

export function wrapDek(
  dek: Buffer,
  userId: string,
  keys: MasterKeys,
): { wrapped: string; masterKeyId: number } {
  const { id, key } = keys.current;
  return { wrapped: `k${id}.${seal(key, dek, `dek:${userId}`)}`, masterKeyId: id };
}

export function unwrapDek(wrapped: string, userId: string, keys: MasterKeys): Buffer {
  const match = /^k(\d+)\.(.+)$/.exec(wrapped);
  if (!match) throw new Error("malformed wrapped key");
  const id = Number(match[1]);
  const master = [keys.current, keys.previous].find((k) => k?.id === id);
  if (!master) throw new Error(`no master key with id ${id}`);
  return open(master.key, match[2]!, `dek:${userId}`);
}

export function generateDek(): Buffer {
  return randomBytes(32);
}

/** Field encryption and dedupe hashing for one user, derived from their DEK. */
export class UserCrypto {
  readonly #fieldKey: Buffer;
  readonly #dedupeKey: Buffer;

  constructor(
    dek: Buffer,
    readonly userId: string,
  ) {
    this.#fieldKey = Buffer.from(
      hkdfSync("sha256", dek, Buffer.alloc(0), "field-encryption-v1", 32),
    );
    this.#dedupeKey = Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), "dedupe-hmac-v1", 32));
  }

  encrypt(field: string, plaintext: string): string {
    return `v1.${seal(this.#fieldKey, Buffer.from(plaintext, "utf8"), `${this.userId}:${field}`)}`;
  }

  decrypt(field: string, value: string): string {
    if (!value.startsWith("v1.")) throw new Error("unknown ciphertext version");
    return open(this.#fieldKey, value.slice(3), `${this.userId}:${field}`).toString("utf8");
  }

  /** Deterministic, irreversible key for de-duplication (hex, 64 chars). */
  dedupe(parts: readonly (string | number | null | undefined)[]): string {
    const h = createHmac("sha256", this.#dedupeKey);
    for (const p of parts) h.update(`${p ?? ""}\u001f`);
    return h.digest("hex");
  }
}
