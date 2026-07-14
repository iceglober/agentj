import { type SecretStore, SecretStoreUnavailableError } from "./index";

export interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(secret: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export type KeyringEntryFactory = (
  service: string,
  account: string,
) => KeyringEntry | Promise<KeyringEntry>;

export interface CreateKeyringSecretStoreOptions {
  createEntry?: KeyringEntryFactory;
}

const createAsyncEntry: KeyringEntryFactory = async (service, account) => {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new AsyncEntry(service, account);
};

function validateEntryIdentity(service: string, account: string): void {
  if (!service || !account) throw new TypeError("Keyring service and account must be nonempty.");
}

export function createKeyringSecretStore({
  createEntry = createAsyncEntry,
}: CreateKeyringSecretStoreOptions = {}): SecretStore {
  return {
    async get(service, account) {
      validateEntryIdentity(service, account);

      try {
        return await (await createEntry(service, account)).getPassword();
      } catch {
        throw new SecretStoreUnavailableError();
      }
    },

    async set(service, account, secret) {
      validateEntryIdentity(service, account);

      try {
        await (await createEntry(service, account)).setPassword(secret);
      } catch {
        throw new SecretStoreUnavailableError();
      }
    },

    async delete(service, account) {
      validateEntryIdentity(service, account);

      try {
        return await (await createEntry(service, account)).deleteCredential();
      } catch {
        throw new SecretStoreUnavailableError();
      }
    },
  };
}
