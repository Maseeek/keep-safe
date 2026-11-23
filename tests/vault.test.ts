import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createVault, deleteLogin, forgetVault, fromBase64url, hasVault, listLogins, loginOrigin, loginsFor, readLogin, saveLogin, unlockVault,
  VaultError, type PrfAuthenticator, type VaultStore,
} from '../apps/web/src/vault';

/** A passkey stand-in: PRF is an HMAC under a secret only this "phone" holds. */
function fakePasskey(options: { prfOnCreate?: boolean } = {}) {
  const secret = randomBytes(32); const id = randomBytes(16); let approvals = 0;
  const prf = (salt: Uint8Array) => new Uint8Array(createHmac('sha256', secret).update(salt).digest());
  const authenticator: PrfAuthenticator = {
    async create(salt) { approvals++; return { credentialId: new Uint8Array(id), prf: options.prfOnCreate === false ? undefined : prf(salt) }; },
    async evaluate(credentialId, salt) {
      approvals++;
      if (Buffer.compare(Buffer.from(credentialId), id) !== 0) throw new VaultError('unknown passkey', 'cancelled');
      return prf(salt);
    },
  };
  return { authenticator, get approvals() { return approvals; } };
}
function memoryStore(): VaultStore & { text: string | null } {
  const store = { text: null as string | null, read: () => store.text, write: (value: string | null) => { store.text = value; } };
  return store;
}

describe('saved logins on the phone', () => {
  it('stores only origins and ciphertext, and opens with the same passkey', async () => {
    const store = memoryStore(); const passkey = fakePasskey();
    const unlocked = await createVault(passkey.authenticator, store);
    expect(hasVault(store)).toBe(true);
    await saveLogin(unlocked, 'https://accounts.example.com', { username: 'owner@example.com', password: 'correct horse battery' }, store);
    expect(store.text).not.toContain('owner@example.com');
    expect(store.text).not.toContain('correct horse');
    expect(store.text).toContain('https://accounts.example.com');
    // The unlocked key cannot be read back out of memory.
    expect(unlocked.key.extractable).toBe(false);

    const again = await unlockVault(passkey.authenticator, store);
    const [entry] = loginsFor('https://accounts.example.com', store);
    expect(await readLogin(again, entry.id, store)).toEqual({ username: 'owner@example.com', password: 'correct horse battery', origin: 'https://accounts.example.com' });
    expect(loginsFor('https://accounts.example.com.evil.test', store)).toEqual([]);
    expect(loginsFor('http://accounts.example.com', store)).toEqual([]);
  });

  it('asks the passkey a second time when it gives no secret as it is made', async () => {
    const store = memoryStore(); const passkey = fakePasskey({ prfOnCreate: false });
    const unlocked = await createVault(passkey.authenticator, store);
    expect(passkey.approvals).toBe(2);
    await saveLogin(unlocked, 'https://example.com', { username: 'a', password: 'b' }, store);
    expect(await readLogin(await unlockVault(passkey.authenticator, store), listLogins(store)[0].id, store)).toMatchObject({ password: 'b' });
  });

  it('will not open with another passkey, and an entry moved to another site fails to decrypt', async () => {
    const store = memoryStore(); const passkey = fakePasskey();
    const unlocked = await createVault(passkey.authenticator, store);
    const saved = await saveLogin(unlocked, 'https://bank.example', { username: 'me', password: 'secret' }, store);

    // Another phone's passkey for the same credential id still derives the wrong key.
    const other = fakePasskey();
    const impostor: PrfAuthenticator = { create: other.authenticator.create, evaluate: async (_id, salt) => other.authenticator.evaluate(new Uint8Array(0), salt).catch(() => new Uint8Array(randomBytes(32))) };
    await expect(unlockVault(impostor, store)).rejects.toMatchObject({ code: 'damaged' });

    // Someone with write access to storage relabels the bank entry as their site.
    const vault = JSON.parse(store.text!); vault.entries[0].origin = 'https://evil.example'; store.text = JSON.stringify(vault);
    await expect(readLogin(unlocked, saved.id, store)).rejects.toMatchObject({ code: 'damaged' });
  });

  it('replaces the same account on a site, keeps others, and deletes without unlocking', async () => {
    const store = memoryStore(); const passkey = fakePasskey();
    const unlocked = await createVault(passkey.authenticator, store);
    const first = await saveLogin(unlocked, 'https://example.com', { username: 'one', password: 'old' }, store);
    await saveLogin(unlocked, 'https://example.com', { username: 'two', password: 'x' }, store);
    const replaced = await saveLogin(unlocked, 'https://example.com', { username: 'one', password: 'new' }, store);
    expect(replaced.id).toBe(first.id);
    expect(listLogins(store)).toHaveLength(2);
    expect(await readLogin(unlocked, first.id, store)).toMatchObject({ password: 'new' });
    deleteLogin(first.id, store);
    expect(listLogins(store)).toHaveLength(1);
    forgetVault(store);
    expect(hasVault(store)).toBe(false);
    await expect(unlockVault(passkey.authenticator, store)).rejects.toMatchObject({ code: 'missing' });
  });

  it('refuses addresses that are not websites, and a damaged store', async () => {
    const store = memoryStore(); const unlocked = await createVault(fakePasskey().authenticator, store);
    expect(loginOrigin('https://a.example/path?q=1')).toBe('https://a.example');
    expect(loginOrigin('file:///etc/passwd')).toBeNull();
    await expect(saveLogin(unlocked, 'https://a.example/path', { username: '', password: 'p' }, store)).rejects.toBeInstanceOf(VaultError);
    await expect(saveLogin(unlocked, 'https://a.example', { username: 'u', password: '' }, store)).rejects.toBeInstanceOf(VaultError);
    store.text = '{"v":2}';
    expect(() => listLogins(store)).toThrow(VaultError);
    expect(loginsFor('https://a.example', store)).toEqual([]);
    expect(fromBase64url('AQID')).toEqual(new Uint8Array([1, 2, 3]));
  });
});
