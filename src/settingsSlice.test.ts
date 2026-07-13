import fc from "fast-check";
import { beforeEach, describe, expect, it } from "vitest";
import * as Cache from "./cache";
import * as Settings from "./settingsSlice";

const userId = "user_1";

const cachedSettings = (theme: Settings.Theme = "system"): Cache.CachedSettings => {
  return { version: 1, userId, theme };
};

const readyState = (theme: Settings.Theme = "system"): Settings.State => {
  return Settings.initialState(userId, cachedSettings(theme));
};

describe("settingsSlice", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("changes local state and derives effects through the public update", () => {
    Cache.writeCachedSettings(cachedSettings());
    const oldState = readyState();

    const [newState, commands] = Settings.update({ kind: "ThemeChanged", theme: "dark" }, oldState);

    expect(newState).toEqual({
      userId,
      theme: "dark",
      syncingTheme: "dark",
      themeSyncError: false,
    });
    expect(Cache.readCachedSettings(userId)).toEqual(cachedSettings());
    expect(commands).toEqual([
      { kind: "ApplyTheme", theme: "dark" },
      { kind: "SaveSettings", settings: cachedSettings("dark") },
      { kind: "SyncTheme", theme: "dark", userId },
    ]);
  });

  it("applies and caches a background pull without pushing it back", () => {
    const [state, commands] = Settings.update(
      { kind: "RemoteLoaded", expectedTheme: "system", theme: "dark", userId },
      readyState(),
    );

    expect(state.theme).toBe("dark");
    expect(state.syncingTheme).toBe(null);
    expect(commands).toEqual([
      { kind: "ApplyTheme", theme: "dark" },
      { kind: "SaveSettings", settings: cachedSettings("dark") },
    ]);
  });

  it("ignores a background pull when the local theme changed after the request began", () => {
    const [localState] = Settings.update({ kind: "ThemeChanged", theme: "light" }, readyState());
    const [state, commands] = Settings.update(
      { kind: "RemoteLoaded", expectedTheme: "system", theme: "dark", userId },
      localState,
    );

    expect(state).toBe(localState);
    expect(commands).toEqual([]);
  });

  it("keeps a failed local theme and exposes a retry", () => {
    const [syncing] = Settings.update({ kind: "ThemeChanged", theme: "dark" }, readyState());
    const [failed, commands] = Settings.update(
      { kind: "ThemeSyncFailed", theme: "dark", userId },
      syncing,
    );

    expect(failed.theme).toBe("dark");
    expect(failed.syncingTheme).toBe(null);
    expect(failed.themeSyncError).toBe(true);
    expect(commands).toEqual([]);

    const [retrying, retryCommands] = Settings.update({ kind: "ThemeSyncRetryRequested" }, failed);

    expect(retrying.themeSyncError).toBe(false);
    expect(retrying.syncingTheme).toBe("dark");
    expect(retryCommands).toEqual([{ kind: "SyncTheme", theme: "dark", userId }]);
  });

  it("serializes requests and skips an obsolete failure", () => {
    const [syncingDark] = Settings.update({ kind: "ThemeChanged", theme: "dark" }, readyState());
    const [waitingForDark, lightCommands] = Settings.update(
      { kind: "ThemeChanged", theme: "light" },
      syncingDark,
    );

    expect(waitingForDark.syncingTheme).toBe("dark");
    expect(lightCommands).toEqual([
      { kind: "ApplyTheme", theme: "light" },
      { kind: "SaveSettings", settings: cachedSettings("light") },
    ]);

    const [syncingLight, nextCommands] = Settings.update(
      { kind: "ThemeSyncFailed", theme: "dark", userId },
      waitingForDark,
    );

    expect(syncingLight.theme).toBe("light");
    expect(syncingLight.syncingTheme).toBe("light");
    expect(syncingLight.themeSyncError).toBe(false);
    expect(nextCommands).toEqual([{ kind: "SyncTheme", theme: "light", userId }]);
  });

  it("ignores a sync response from a previous user", () => {
    const [syncing] = Settings.update({ kind: "ThemeChanged", theme: "dark" }, readyState());
    const [state, commands] = Settings.update(
      { kind: "ThemeSyncFailed", theme: "dark", userId: "user_2" },
      syncing,
    );

    expect(state).toBe(syncing);
    expect(commands).toEqual([]);
  });

  it("normalizes the abandoned replica cache format to simple settings", () => {
    window.localStorage.setItem(
      `kestrel.settings.${userId}`,
      JSON.stringify({
        version: 2,
        userId,
        theme: "dark",
        nextOperationSequence: 4,
        pendingTheme: null,
        revision: 8,
      }),
    );

    expect(Cache.readCachedSettings(userId)).toEqual(cachedSettings("dark"));
    expect(Settings.fromCache(userId)).toEqual(readyState("dark"));
  });

  it("writes settings synchronously without a follow-up message", () => {
    const messages: Settings.Msg[] = [];

    Settings.runCmd({ kind: "SaveSettings", settings: cachedSettings("dark") }, (msg) =>
      messages.push(msg),
    );

    expect(Cache.readCachedSettings(userId)).toEqual(cachedSettings("dark"));
    expect(messages).toEqual([]);
  });

  it("keeps local storage aligned through arbitrary local changes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Settings.Theme>("system", "light", "dark"), {
          minLength: 1,
          maxLength: 100,
        }),
        (themes) => {
          const driver = new SettingsDriver("hold");

          themes.forEach((theme) => {
            driver.dispatch({ kind: "ThemeChanged", theme });
            expect(driver.store).toEqual(Settings.toCachedSettings(driver.state));
          });
        },
      ),
    );
  });

  it("finishes arbitrary successful synchronization sequences", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<Settings.Theme>("system", "light", "dark"), {
          minLength: 1,
          maxLength: 50,
        }),
        (themes) => {
          const driver = new SettingsDriver("succeed");

          themes.forEach((theme) => {
            driver.dispatch({ kind: "ThemeChanged", theme });
          });

          expect(driver.store).toEqual(Settings.toCachedSettings(driver.state));
          expect(driver.state.syncingTheme).toBe(null);
          expect(driver.state.themeSyncError).toBe(false);
        },
      ),
    );
  });
});

type SyncBehavior = "hold" | "succeed";

class SettingsDriver {
  state = readyState();
  store = cachedSettings();

  readonly #messages: Settings.Msg[] = [];
  readonly #syncBehavior: SyncBehavior;

  constructor(syncBehavior: SyncBehavior) {
    this.#syncBehavior = syncBehavior;
  }

  dispatch(msg: Settings.Msg) {
    this.#messages.push(msg);
    this.#drain();
  }

  #drain() {
    while (this.#messages.length > 0) {
      const msg = this.#messages.shift();
      if (msg === undefined) {
        continue;
      }

      const [state, commands] = Settings.update(msg, this.state);
      this.state = state;

      commands.forEach((cmd) => {
        switch (cmd.kind) {
          case "SaveSettings":
            this.store = cmd.settings;
            return;
          case "SyncTheme":
            if (this.#syncBehavior === "succeed") {
              this.#messages.push({ kind: "ThemeSynced", theme: cmd.theme, userId: cmd.userId });
            }
            return;
          case "ApplyTheme":
          case "LoadRemote":
            return;
        }
      });
    }
  }
}
