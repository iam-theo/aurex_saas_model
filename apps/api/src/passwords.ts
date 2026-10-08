import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (pw: string, salt: string, len: number) => Promise<Buffer>;
const KEYLEN = 64;

/** Hash a password with a random per-user salt: `scrypt:<saltHex>:<hashHex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt, KEYLEN)).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

/** Timing-safe password check against a stored `scrypt:` string. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, hash] = parts;
  try {
    const candidate = (await scrypt(password, salt, KEYLEN)).toString("hex");
    const a = Buffer.from(candidate, "hex");
    const b = Buffer.from(hash, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}