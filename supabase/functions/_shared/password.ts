// Password hashing via Web Crypto PBKDF2 (no native/WASM deps, safe to run
// in the edge runtime). Stored format: pbkdf2$<iterations>$<saltB64>$<hashB64>

const ITERATIONS = 100_000;
const HASH_ALGO = "SHA-256";
const KEY_LENGTH_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Verifica una contraseña contra un hash legado `pbkdf2$...`. Ya no se usa
 * para crear usuarios (las credenciales viven en Supabase Auth); solo para
 * migrar al vuelo a los usuarios previos en su primer login.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const [scheme, iterations, saltB64, hashB64] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !saltB64 || !hashB64) return false;
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: fromBase64(saltB64),
      iterations: Number(iterations),
      hash: HASH_ALGO,
    },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  const a = new Uint8Array(derivedBits);
  const b = fromBase64(hashB64);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: HASH_ALGO },
    keyMaterial,
    KEY_LENGTH_BITS,
  );
  const hash = toBase64(new Uint8Array(derivedBits));
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${hash}`;
}
