/**
 * The host is the only place credentials live.
 *
 * Keys are encrypted with Electron's safeStorage, which on GNOME is backed by
 * the login keyring (gnome-libsecret). Ciphertext goes to disk; the plaintext
 * exists only in memory, and reaches pi solely through its process environment.
 * The VM therefore holds no API keys at rest -- snapshot its disk and you get
 * nothing.
 *
 * If no keyring is available Electron falls back to encrypting with a HARDCODED
 * password, which is not encryption in any meaningful sense. We detect that and
 * refuse to persist rather than offering a false guarantee.
 */

import { safeStorage } from "electron";
import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export { CONFIG_DIR } from "../core/paths.ts";
import { CONFIG_DIR, makeOwnDir, OWNER_ONLY_FILE } from "../core/paths.ts";
const SECRETS_PATH = join(CONFIG_DIR, "secrets.enc.json");

/** Logical secret names. `bridgeToken` authenticates the VM, not a provider. */
/* hfToken is here rather than in settings.json for the same reason as the
 * others: a HuggingFace access token grants read access to a person's private
 * repositories, so it belongs in the keyring, not in a JSON file. */
/**
 * The named secrets, plus one key per configured provider.
 *
 * Providers are added at runtime, so their names cannot be enumerated here.
 * They are namespaced instead, which is what keeps a provider called "llmKey"
 * from overwriting the built-in one. Declared in core so the boundary check can
 * be tested without Electron.
 */
export { isSecretName, type SecretName } from "../core/secretNames.ts";
import { vaultAction, type SecretName } from "../core/secretNames.ts";

export interface VaultStatus {
  usable: boolean;
  backend: string;
  reason: string;
}

type Stored = Record<string, string>; // name -> base64 ciphertext

export interface SetResult {
  /** True when the value was encrypted to disk; false when session-only. */
  persisted: boolean;
}

export class SecretVault {
  #cache: Stored | undefined;
  /**
   * Secrets we could not protect at rest, held for this run only.
   *
   * Refusing to store must not mean refusing to work. When the keyring cannot
   * persist, keeping the key in memory is strictly better than both
   * alternatives: it still never touches disk (the property that matters), and
   * the user is told plainly that it will not survive a restart.
   */
  #memory = new Map<SecretName, string>();

  /**
   * Cached result of the persistence probe. `undefined` until first checked.
   */
  #persistenceOk: boolean | undefined;

  /**
   * Verify that ciphertext actually SURVIVES A RESTART, not merely that the API
   * claims to be available.
   *
   * isEncryptionAvailable() can return true and report the gnome_libsecret
   * backend while writes silently land in the memory-only `session` collection
   * -- which happens when the session has no persistent default collection.
   * The symptom is a vault that appears healthy and quietly loses every secret
   * on restart, which is worse than an honest failure. So we keep a probe
   * blob on disk and re-decrypt it each launch.
   */
  async checkPersistence(): Promise<boolean> {
    if (this.#persistenceOk !== undefined) return this.#persistenceOk;
    if (!safeStorage.isEncryptionAvailable()) return (this.#persistenceOk = false);

    const probePath = join(CONFIG_DIR, "keyring-probe.bin");
    try {
      const existing = await readFile(probePath, "utf8").catch(() => undefined);
      if (existing) {
        safeStorage.decryptString(Buffer.from(existing, "base64"));
        return (this.#persistenceOk = true);
      }
      await makeOwnDir(CONFIG_DIR);
      await writeFile(probePath, safeStorage.encryptString("karen-probe").toString("base64"), {
        mode: OWNER_ONLY_FILE,
      });
      // First run cannot prove persistence yet; assume good and re-check next launch.
      return (this.#persistenceOk = true);
    } catch {
      // The probe existed but would not decrypt: the key did not survive.
      await writeFile(probePath, safeStorage.encryptString("karen-probe").toString("base64"), {
        mode: OWNER_ONLY_FILE,
      }).catch(() => undefined);
      return (this.#persistenceOk = false);
    }
  }

  status(): VaultStatus {
    if (!safeStorage.isEncryptionAvailable()) {
      return { usable: false, backend: "none", reason: "OS encryption is unavailable" };
    }
    if (this.#persistenceOk === false) {
      return {
        usable: false,
        backend: "gnome_libsecret (not persisting)",
        reason:
          "The keyring accepts secrets but loses them on restart — its key is going to a " +
          "memory-only collection. Unlock a persistent login keyring, or supply keys via " +
          "the KAREN_LLM_KEY environment variable instead.",
      };
    }
    // Linux-only; returns a friendly backend name.
    const backend =
      typeof safeStorage.getSelectedStorageBackend === "function"
        ? safeStorage.getSelectedStorageBackend()
        : "unknown";

    if (backend === "basic_text") {
      return {
        usable: false,
        backend,
        reason:
          "No system keyring was detected, so secrets would be encrypted with a " +
          "hardcoded password. Install/unlock gnome-keyring, then restart Karen.",
      };
    }
    return { usable: true, backend, reason: "OS keyring available" };
  }

  async #load(): Promise<Stored> {
    if (this.#cache) return this.#cache;
    try {
      this.#cache = JSON.parse(await readFile(SECRETS_PATH, "utf8")) as Stored;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      this.#cache = {};
    }
    return this.#cache;
  }

  async #save(data: Stored): Promise<void> {
    this.#cache = data;
    await makeOwnDir(dirname(SECRETS_PATH));
    const tmp = `${SECRETS_PATH}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", { mode: OWNER_ONLY_FILE });
    await rename(tmp, SECRETS_PATH);
  }

  async set(name: SecretName, plaintext: string): Promise<SetResult> {
    /*
     * Removal always reaches the disk, whatever the keyring is doing.
     *
     * It used to take the memory-only branch below whenever the vault was not
     * `usable`, which meant it deleted the in-memory copy and left the
     * ciphertext exactly where it was. Two ways that goes wrong, and both are
     * bad in the direction a credential store must never be bad in:
     *
     *   - The secret the user just deleted is still on disk.
     *   - `get()` falls through to disk when memory has nothing, so it is not
     *     merely still there, it is still in USE. Removing a provider's API key
     *     would have gone on sending it.
     *
     * The state that triggers this is reachable in ordinary use: the
     * persistence probe runs when Settings is opened, and on a machine whose
     * keyring will not persist it flips `usable` to false for the rest of the
     * session -- so a key stored earlier in that same session, while it was
     * still true, was on disk and undeletable. Observed, not theorised.
     *
     * Deleting needs no encryption, so there is no reason for it to depend on
     * whether encryption is available.
     */
    if (vaultAction(plaintext, this.status().usable) === "remove") {
      this.#memory.delete(name);
      const data = await this.#load();
      if (!(name in data)) return { persisted: true };
      delete data[name];
      await this.#save(data);
      return { persisted: true };
    }

    if (vaultAction(plaintext, this.status().usable) === "memory") {
      this.#memory.set(name, plaintext);
      return { persisted: false };
    }

    this.#memory.delete(name);
    const data = await this.#load();
    data[name] = safeStorage.encryptString(plaintext).toString("base64");
    await this.#save(data);
    return { persisted: true };
  }

  async get(name: SecretName): Promise<string | undefined> {
    const inMemory = this.#memory.get(name);
    if (inMemory) return inMemory;

    const data = await this.#load();
    const blob = data[name];
    if (!blob) return undefined;
    try {
      return safeStorage.decryptString(Buffer.from(blob, "base64"));
    } catch {
      // Typically means the keyring changed underneath us.
      return undefined;
    }
  }

  /**
   * The names of stored secrets. Names only, never values.
   *
   * Exists so orphaned provider keys can be found and removed. A key whose
   * provider was deleted before that cleanup existed is still sitting on disk,
   * and it will not be noticed by anything else: nothing in the interface lists
   * secrets, which is otherwise the right decision.
   */
  async names(): Promise<string[]> {
    return [...new Set([...Object.keys(await this.#load()), ...this.#memory.keys()])];
  }

  /** Which secrets exist, without revealing any value. */
  async present(): Promise<Record<SecretName, boolean>> {
    const data = await this.#load();
    const has = (n: SecretName): boolean => Boolean(data[n]) || this.#memory.has(n);
    return {
      llmKey: has("llmKey"),
      transcriptionKey: has("transcriptionKey"),
      embedKey: has("embedKey"),
      bridgeToken: has("bridgeToken"),
      hfToken: has("hfToken"),
      ncbiKey: has("ncbiKey"),
      coreKey: has("coreKey"),
    };
  }

  /**
   * Fetch the bridge token, generating one on first run.
   *
   * If the keyring cannot persist, fall back to a 0600 file rather than minting
   * a fresh token every launch -- a rotating token silently breaks pairing on
   * every restart, which is a far worse failure than a plainly-labelled
   * unprotected one. The token must exist in plaintext inside the VM regardless.
   */
  async ensureBridgeToken(): Promise<string> {
    const persistent = await this.checkPersistence();

    if (persistent) {
      const existing = await this.get("bridgeToken");
      if (existing) return existing;
    }

    const fallbackPath = join(CONFIG_DIR, "bridge-token");
    if (!persistent) {
      const fromFile = await readFile(fallbackPath, "utf8").catch(() => undefined);
      if (fromFile?.trim()) return fromFile.trim();
    }

    const token = randomBytes(32).toString("base64url");
    if (persistent) {
      await this.set("bridgeToken", token);
    } else {
      // The token is written to a file deliberately: it must be stable across
      // restarts or pairing breaks, and it already exists in plaintext in the VM.
      await makeOwnDir(CONFIG_DIR);
      await writeFile(fallbackPath, token, { mode: OWNER_ONLY_FILE });
    }
    return token;
  }

  /**
   * The environment handed to the bridge, which injects it into pi only.
   * Names match the "$KAREN_LLM_KEY" references written into models.json.
   */
  async envForBridge(): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    const llm = (await this.get("llmKey")) ?? process.env["KAREN_LLM_KEY"];
    // Falling back to our own environment lets keys come from a password
    // manager or systemd credential without ever touching disk -- which is
    // strictly better than storing them, and the only option when the keyring
    // cannot persist.
    if (llm) env["KAREN_LLM_KEY"] = llm;
    // The embeddings endpoint is reached from inside the VM too, so its key
    // travels the same path and is never written to disk there.
    const embed = (await this.get("embedKey")) ?? process.env["KAREN_EMBED_KEY"];
    if (embed) env["KAREN_EMBED_KEY"] = embed;
    return env;
  }
}
