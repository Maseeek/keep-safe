/**
 * Saved logins, encrypted on this phone and unlocked with a passkey.
 *
 * The design follows password managers that let an agent use a login without
 * seeing it (1Password with Instinct): the secret lives with the person, every
 * use is approved by them, and the agent is never handed the value. Here:
 *
 * - A random 256-bit vault key encrypts each entry with AES-GCM. The entry's
 *   id and origin are the additional data, so an entry cannot be moved to
 *   another site by editing storage.
 * - The vault key is stored only wrapped, by a key derived (HKDF-SHA-256) from
 *   the passkey's PRF output. Only this phone's passkey, with the owner's face,
 *   fingerprint or screen lock, can produce that output.
 * - Storage holds the wrapped key, each entry's origin, and ciphertext. No
 *   username or password is ever stored or sent anywhere in the clear. The
 *   bridge on the computer sees a value only as typing into the page, as it
 *   does when the owner types it by hand.
 * - An unlocked vault is a non-extractable key in memory. The caller drops it
 *   when the owner leaves the sign-in or the app is hidden.
 */

export interface SavedLogin { username: string; password: string }
/** What can be listed without unlocking: the site, never the account. */
export interface VaultEntrySummary { id: string; origin: string; createdAt: string; updatedAt: string }
interface StoredEntry extends VaultEntrySummary { data: string }
interface StoredVault {
  v: 1;
  /** The passkey that unlocks this vault, base64url. */
  credentialId: string;
  /** Sent to the passkey's PRF with every unlock, base64url. Not secret. */
  salt: string;
  /** The vault key, wrapped with the passkey-derived key: IV then ciphertext, base64url. */
  wrapped: string;
  createdAt: string;
  entries: StoredEntry[];
}

/** A passkey that can return a PRF secret. Browsers provide one; tests a stand-in. */
export interface PrfAuthenticator {
  create(salt: Uint8Array): Promise<{ credentialId: Uint8Array; prf?: Uint8Array }>;
  evaluate(credentialId: Uint8Array, salt: Uint8Array): Promise<Uint8Array>;
}
export interface VaultStore { read(): string | null; write(value: string | null): void }
export interface UnlockedVault { readonly key: CryptoKey; readonly credentialId: string }

export class VaultError extends Error {
  constructor(message: string, readonly code: "unsupported" | "cancelled" | "missing" | "damaged" | "locked") { super(message); }
}

const storageKey = "keep-safe.vault.v1";
const keyInfo = new TextEncoder().encode("keep-safe vault key-encryption v1");
const wrapData = (credentialId: string) => new TextEncoder().encode(`keep-safe vault key ${credentialId}`);
const entryData = (id: string, origin: string) => new TextEncoder().encode(`keep-safe entry ${id} ${origin}`);
const maxEntries = 200;
const maxField = 1024;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
const join = (a: Uint8Array, b: Uint8Array) => { const out = new Uint8Array(a.length + b.length); out.set(a); out.set(b, a.length); return out; };

/** Only a web origin can hold a login: scheme, host and port, no path. */
export function loginOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.origin : null;
  } catch { return null; }
}

export function browserStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined = globalThis.localStorage): VaultStore {
  return {
    read() { try { return storage?.getItem(storageKey) ?? null; } catch { return null; } },
    write(value) {
      if (!storage) throw new VaultError("This browser cannot keep saved logins.", "unsupported");
      if (value === null) storage.removeItem(storageKey); else storage.setItem(storageKey, value);
    },
  };
}

function load(store: VaultStore): StoredVault | null {
  const text = store.read();
  if (!text) return null;
  try {
    const value = JSON.parse(text) as StoredVault;
    if (value?.v !== 1 || typeof value.credentialId !== "string" || typeof value.salt !== "string" || typeof value.wrapped !== "string" || !Array.isArray(value.entries)) throw new Error();
    return value;
  } catch { throw new VaultError("The saved logins on this phone are damaged. Forget them and save them again.", "damaged"); }
}
const save = (store: VaultStore, vault: StoredVault) => store.write(JSON.stringify(vault));

async function wrappingKey(prf: Uint8Array): Promise<CryptoKey> {
  if (prf.length < 32) throw new VaultError("This passkey did not return a usable secret.", "unsupported");
  const material = await crypto.subtle.importKey("raw", new Uint8Array(prf), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: keyInfo }, material, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}

async function unwrap(vault: StoredVault, prf: Uint8Array): Promise<UnlockedVault> {
  const sealed = fromBase64url(vault.wrapped);
  try {
    const key = await crypto.subtle.unwrapKey("raw", sealed.slice(12), await wrappingKey(prf),
      { name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: wrapData(vault.credentialId) },
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    return { key, credentialId: vault.credentialId };
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError("This passkey does not open the saved logins on this phone.", "damaged");
  }
}

export function hasVault(store: VaultStore = browserStore()): boolean {
  try { return !!load(store); } catch { return true; }
}

/** Creates the vault with a new passkey. Replaces nothing: forget an old vault first. */
export async function createVault(authenticator: PrfAuthenticator, store: VaultStore = browserStore()): Promise<UnlockedVault> {
  if (store.read()) throw new VaultError("This phone already has saved logins.", "damaged");
  const salt = random(32);
  const created = await authenticator.create(salt);
  // Some platforms only say PRF is enabled when the passkey is made, and give
  // the secret on its first use. That asks for the owner's face or finger twice.
  const prf = created.prf ?? await authenticator.evaluate(created.credentialId, salt);
  const credentialId = base64url(created.credentialId);
  const vaultKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const iv = random(12);
  const wrapped = await crypto.subtle.wrapKey("raw", vaultKey, await wrappingKey(prf), { name: "AES-GCM", iv, additionalData: wrapData(credentialId) });
  const vault: StoredVault = { v: 1, credentialId, salt: base64url(salt), wrapped: base64url(join(iv, new Uint8Array(wrapped))), createdAt: new Date().toISOString(), entries: [] };
  // Hold only a key that cannot be read back out, as an unlock would.
  const unlocked = await unwrap(vault, prf);
  save(store, vault);
  return unlocked;
}

/** Asks the passkey, which asks the owner. Each call is one approval. */
export async function unlockVault(authenticator: PrfAuthenticator, store: VaultStore = browserStore()): Promise<UnlockedVault> {
  const vault = load(store);
  if (!vault) throw new VaultError("There are no saved logins on this phone yet.", "missing");
  return unwrap(vault, await authenticator.evaluate(fromBase64url(vault.credentialId), fromBase64url(vault.salt)));
}

export function listLogins(store: VaultStore = browserStore()): VaultEntrySummary[] {
  return (load(store)?.entries ?? []).map(({ id, origin, createdAt, updatedAt }) => ({ id, origin, createdAt, updatedAt }));
}
export function loginsFor(origin: string | null, store: VaultStore = browserStore()): VaultEntrySummary[] {
  if (!origin) return [];
  try { return listLogins(store).filter(entry => entry.origin === origin); } catch { return []; }
}

function checkUnlocked(vault: StoredVault, unlocked: UnlockedVault) {
  if (unlocked.credentialId !== vault.credentialId) throw new VaultError("Unlock the saved logins again.", "locked");
}

export async function readLogin(unlocked: UnlockedVault, id: string, store: VaultStore = browserStore()): Promise<SavedLogin & { origin: string }> {
  const vault = load(store);
  if (!vault) throw new VaultError("There are no saved logins on this phone yet.", "missing");
  checkUnlocked(vault, unlocked);
  const entry = vault.entries.find(item => item.id === id);
  if (!entry) throw new VaultError("That saved login is gone.", "missing");
  const sealed = fromBase64url(entry.data);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.slice(0, 12), additionalData: entryData(entry.id, entry.origin) }, unlocked.key, sealed.slice(12));
    const value = JSON.parse(new TextDecoder().decode(plain)) as SavedLogin;
    return { username: String(value.username ?? ""), password: String(value.password ?? ""), origin: entry.origin };
  } catch { throw new VaultError("That saved login is damaged. Delete it and save it again.", "damaged"); }
}

/** Saves a login for one site, replacing the entry with the same username there. */
export async function saveLogin(unlocked: UnlockedVault, origin: string, login: SavedLogin, store: VaultStore = browserStore()): Promise<VaultEntrySummary> {
  const site = loginOrigin(origin);
  if (!site || site !== origin) throw new VaultError("Logins can be saved only for a website address.", "damaged");
  if (!login.password || login.password.length > maxField || login.username.length > maxField) throw new VaultError("Enter a password of up to 1024 characters.", "damaged");
  const vault = load(store);
  if (!vault) throw new VaultError("There are no saved logins on this phone yet.", "missing");
  checkUnlocked(vault, unlocked);
  let replaced: StoredEntry | undefined;
  for (const entry of vault.entries.filter(item => item.origin === site)) {
    if ((await readLogin(unlocked, entry.id, store).catch(() => null))?.username === login.username) replaced = entry;
  }
  if (!replaced && vault.entries.length >= maxEntries) throw new VaultError("This phone holds 200 saved logins. Delete one first.", "damaged");
  const id = replaced?.id ?? base64url(random(12));
  const now = new Date().toISOString();
  const iv = random(12);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: entryData(id, site) }, unlocked.key,
    new TextEncoder().encode(JSON.stringify({ username: login.username, password: login.password })));
  const entry: StoredEntry = { id, origin: site, createdAt: replaced?.createdAt ?? now, updatedAt: now, data: base64url(join(iv, new Uint8Array(sealed))) };
  vault.entries = [...vault.entries.filter(item => item.id !== id), entry];
  save(store, vault);
  return { id, origin: site, createdAt: entry.createdAt, updatedAt: now };
}

/** Deleting needs no unlock: it can only take something away. */
export function deleteLogin(id: string, store: VaultStore = browserStore()) {
  const vault = load(store);
  if (!vault) return;
  vault.entries = vault.entries.filter(item => item.id !== id);
  save(store, vault);
}
export function forgetVault(store: VaultStore = browserStore()) { store.write(null); }

/** Whether this browser can make a passkey that unlocks a vault. Unknown until
 * a passkey is made on browsers without client capabilities, so `maybe`. */
export async function vaultSupport(): Promise<"yes" | "no" | "maybe"> {
  const credential = globalThis.PublicKeyCredential as (typeof PublicKeyCredential & { getClientCapabilities?: () => Promise<Record<string, boolean>> }) | undefined;
  if (!credential || !globalThis.isSecureContext || !navigator.credentials) return "no";
  try {
    const capabilities = await credential.getClientCapabilities?.();
    if (capabilities && capabilities["extension:prf"] === false) return "no";
    if (capabilities?.["extension:prf"] && capabilities.userVerifyingPlatformAuthenticator !== false) return "yes";
    if (!await credential.isUserVerifyingPlatformAuthenticatorAvailable()) return "no";
  } catch { return "maybe"; }
  return "maybe";
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };
const prfBytes = (results: PrfResults) => {
  const first = results.prf?.results?.first;
  if (!first) return undefined;
  return first instanceof ArrayBuffer ? new Uint8Array(first) : new Uint8Array(first.buffer, first.byteOffset, first.byteLength);
};
function cancelled(error: unknown): never {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError"))
    throw new VaultError("The passkey was not approved.", "cancelled");
  if (error instanceof VaultError) throw error;
  throw new VaultError("This phone could not use a passkey for saved logins.", "unsupported");
}

/** The phone's own passkeys, through WebAuthn with the PRF extension. The
 * relying party is this website, so a vault belongs to the address it was
 * made on, as its storage already does. */
export function browserAuthenticator(): PrfAuthenticator {
  return {
    async create(salt) {
      let credential: PublicKeyCredential | null;
      try {
        credential = await navigator.credentials.create({ publicKey: {
          rp: { name: "Keep Safe" },
          user: { id: random(16), name: "Keep Safe saved logins", displayName: "Keep Safe saved logins" },
          challenge: random(32),
          pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
          timeout: 120_000,
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        } }) as PublicKeyCredential | null;
      } catch (error) { cancelled(error); }
      if (!credential) throw new VaultError("The passkey was not approved.", "cancelled");
      const results = credential.getClientExtensionResults() as PrfResults;
      if (!results.prf?.enabled && !prfBytes(results)) throw new VaultError("This phone's passkeys cannot protect saved logins. Keep using your password manager with the Passwords boxes.", "unsupported");
      return { credentialId: new Uint8Array(credential.rawId), prf: prfBytes(results) };
    },
    async evaluate(credentialId, salt) {
      let credential: PublicKeyCredential | null;
      try {
        credential = await navigator.credentials.get({ publicKey: {
          challenge: random(32),
          allowCredentials: [{ type: "public-key", id: new Uint8Array(credentialId) }],
          userVerification: "required",
          timeout: 120_000,
          extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        } }) as PublicKeyCredential | null;
      } catch (error) { cancelled(error); }
      if (!credential) throw new VaultError("The passkey was not approved.", "cancelled");
      const prf = prfBytes(credential.getClientExtensionResults() as PrfResults);
      if (!prf) throw new VaultError("This phone's passkeys cannot protect saved logins. Keep using your password manager with the Passwords boxes.", "unsupported");
      return prf;
    },
  };
}
