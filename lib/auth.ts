// Single-user password login. Cookie = "<expiry>.<hmac>", signed with the session key
// (SESSION_SECRET if set, otherwise derived from the Supabase service-role key).
// Uses Web Crypto so it runs in middleware and in Node.

export const COOKIE = "ss_session";
const MAX_AGE_S = 60 * 60 * 24 * 90; // 90 days — this is a phone app, stay signed in

const enc = new TextEncoder();

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  let bin = "";
  for (const b of new Uint8Array(sig)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signing key for session cookies. Derived so no extra secret has to be created or copied anywhere. */
export async function sessionKey(): Promise<string | undefined> {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return base ? hmac(base, "ss-session-key-v1") : undefined;
}

export async function makeSession(secret: string) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  return { value: `${exp}.${await hmac(secret, `session:${exp}`)}`, maxAge: MAX_AGE_S };
}

export async function verifySession(secret: string | undefined, value: string | undefined): Promise<boolean> {
  if (!secret || !value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(secret, `session:${exp}`));
}

export async function checkPassword(input: string, expected: string | undefined): Promise<boolean> {
  if (!expected) return false;
  // Compare digests so timing doesn't leak length or prefix.
  const [a, b] = await Promise.all([hmac("pw", input), hmac("pw", expected)]);
  return safeEqual(a, b);
}

export { safeEqual };
