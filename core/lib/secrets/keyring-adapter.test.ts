import { describe, expect, mock, test } from "bun:test";
import { SecretStoreUnavailableError } from "./index";
import { createKeyringSecretStore, type KeyringEntry } from "./keyring-adapter";

const fixtureSecret = "fixture-secret-must-not-leak";
const nativeErrorText = "native-keychain-error-must-not-leak";

async function expectUnavailable(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
    expect.unreachable("Expected the keyring operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(SecretStoreUnavailableError);
    expect(error).toMatchObject({
      name: "SecretStoreUnavailableError",
      message: "The secure secret store is unavailable.",
    });
    expect(String(error)).not.toContain(nativeErrorText);
    expect(String(error)).not.toContain(fixtureSecret);
  }
}

describe("createKeyringSecretStore", () => {
  test("gets missing and stored secrets through entries constructed per service and account", async () => {
    const getPassword = mock<() => Promise<string | undefined>>();
    getPassword.mockResolvedValueOnce(undefined).mockResolvedValueOnce(fixtureSecret);
    const enumerateCredentials = mock(() => {
      throw new Error("Enumeration must not be used");
    });
    const createEntry = mock((service: string, account: string) => ({
      getPassword,
      setPassword: async () => {},
      deleteCredential: async () => false,
      enumerateCredentials,
    }));
    const store = createKeyringSecretStore({ createEntry });

    await expect(store.get("first-service", "first-account")).resolves.toBeUndefined();
    await expect(store.get("second-service", "second-account")).resolves.toBe(fixtureSecret);

    expect(createEntry).toHaveBeenNthCalledWith(1, "first-service", "first-account");
    expect(createEntry).toHaveBeenNthCalledWith(2, "second-service", "second-account");
    expect(getPassword).toHaveBeenCalledTimes(2);
    expect(enumerateCredentials).not.toHaveBeenCalled();
    expect(store).not.toHaveProperty("enumerateCredentials");
  });

  test("sets the exact secret and returns the native delete result", async () => {
    const setPassword = mock<(secret: string) => Promise<void>>();
    const deleteCredential = mock<() => Promise<boolean>>();
    deleteCredential.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const createEntry = mock(
      (): KeyringEntry => ({
        getPassword: async () => undefined,
        setPassword,
        deleteCredential,
      }),
    );
    const store = createKeyringSecretStore({ createEntry });

    await store.set("azure", "primary", fixtureSecret);
    await expect(store.delete("azure", "primary")).resolves.toBe(true);
    await expect(store.delete("azure", "secondary")).resolves.toBe(false);

    expect(setPassword).toHaveBeenCalledTimes(1);
    expect(setPassword).toHaveBeenCalledWith(fixtureSecret);
    expect(createEntry).toHaveBeenNthCalledWith(1, "azure", "primary");
    expect(createEntry).toHaveBeenNthCalledWith(2, "azure", "primary");
    expect(createEntry).toHaveBeenNthCalledWith(3, "azure", "secondary");
  });

  test("rejects blank service or account before constructing an entry", async () => {
    const createEntry = mock(
      (): KeyringEntry => ({
        getPassword: async () => undefined,
        setPassword: async () => {},
        deleteCredential: async () => false,
      }),
    );
    const store = createKeyringSecretStore({ createEntry });

    await expect(store.get("", "account")).rejects.toThrow(TypeError);
    await expect(store.set("service", "", fixtureSecret)).rejects.toThrow(TypeError);
    await expect(store.delete("", "")).rejects.toThrow(TypeError);

    expect(createEntry).not.toHaveBeenCalled();
  });

  test("redacts native factory, get, set, and delete failures", async () => {
    const failingFactory = () => {
      throw new Error(nativeErrorText);
    };
    const failingEntry: KeyringEntry = {
      getPassword: async () => {
        throw new Error(nativeErrorText);
      },
      setPassword: async () => {
        throw new Error(`${nativeErrorText}: ${fixtureSecret}`);
      },
      deleteCredential: async () => {
        throw new Error(nativeErrorText);
      },
    };

    await expectUnavailable(() => createKeyringSecretStore({ createEntry: failingFactory }).get("service", "account"));
    await expectUnavailable(() => createKeyringSecretStore({ createEntry: () => failingEntry }).get("service", "account"));
    await expectUnavailable(() => createKeyringSecretStore({ createEntry: () => failingEntry }).set("service", "account", fixtureSecret));
    await expectUnavailable(() => createKeyringSecretStore({ createEntry: () => failingEntry }).delete("service", "account"));
  });
});
