import { api } from "./api/client";
import * as Cache from "./cache";
import * as Mvu from "./mvu";

export type Theme = "dark" | "light" | "system";
export const DEFAULT_THEME: Theme = "system";

export type State = {
  userId: string;
  theme: Theme;
  syncingTheme: Theme | null;
  themeSyncError: boolean;
};

export type Cmd =
  | {
      kind: "LoadRemote";
      expectedTheme: Theme;
      userId: string;
    }
  | {
      kind: "SaveSettings";
      settings: Cache.CachedSettings;
    }
  | {
      kind: "SyncTheme";
      theme: Theme;
      userId: string;
    }
  | {
      kind: "ApplyTheme";
      theme: Theme;
    };

export type Msg =
  | { kind: "RemoteLoaded"; expectedTheme: Theme; theme: Theme; userId: string }
  | { kind: "ThemeChanged"; theme: Theme }
  | { kind: "ThemeSynced"; theme: Theme; userId: string }
  | { kind: "ThemeSyncFailed"; theme: Theme; userId: string }
  | { kind: "ThemeSyncRetryRequested" };

export const initialState = (userId: string, cached: Cache.CachedSettings | null = null): State => {
  return {
    userId,
    theme: cached?.theme ?? DEFAULT_THEME,
    syncingTheme: null,
    themeSyncError: false,
  };
};

export const fromCache = (userId: string): State => {
  return initialState(userId, Cache.readCachedSettings(userId));
};

export const toCachedSettings = (state: State): Cache.CachedSettings => {
  return {
    version: 1,
    userId: state.userId,
    theme: state.theme,
  };
};

const localUpdate = (msg: Msg, state: State): Mvu.Transition<State, Cmd> => {
  switch (msg.kind) {
    case "RemoteLoaded": {
      if (state.userId !== msg.userId) {
        return [state, Mvu.Cmd.none()];
      }

      const localThemeChangedSinceRequest = state.theme !== msg.expectedTheme;
      if (localThemeChangedSinceRequest || state.syncingTheme !== null) {
        return [state, Mvu.Cmd.none()];
      }

      return [
        {
          ...state,
          theme: msg.theme,
          themeSyncError: false,
        },
        Mvu.Cmd.none(),
      ];
    }
    case "ThemeChanged": {
      if (state.theme === msg.theme) {
        return [state, Mvu.Cmd.none()];
      }

      return [
        {
          ...state,
          theme: msg.theme,
          syncingTheme: state.syncingTheme ?? msg.theme,
          themeSyncError: false,
        },
        Mvu.Cmd.none(),
      ];
    }
    case "ThemeSynced": {
      if (state.userId !== msg.userId || state.syncingTheme !== msg.theme) {
        return [state, Mvu.Cmd.none()];
      }

      return [
        {
          ...state,
          syncingTheme: state.theme === msg.theme ? null : state.theme,
          themeSyncError: false,
        },
        Mvu.Cmd.none(),
      ];
    }
    case "ThemeSyncFailed": {
      if (state.userId !== msg.userId || state.syncingTheme !== msg.theme) {
        return [state, Mvu.Cmd.none()];
      }

      const failedThemeIsCurrent = state.theme === msg.theme;
      return [
        {
          ...state,
          syncingTheme: failedThemeIsCurrent ? null : state.theme,
          themeSyncError: failedThemeIsCurrent,
        },
        Mvu.Cmd.none(),
      ];
    }
    case "ThemeSyncRetryRequested": {
      if (!state.themeSyncError || state.syncingTheme !== null) {
        return [state, Mvu.Cmd.none()];
      }

      return [
        {
          ...state,
          syncingTheme: state.theme,
          themeSyncError: false,
        },
        Mvu.Cmd.none(),
      ];
    }
  }
};

const themeReactor: Mvu.Reactor<State, Cmd> = (oldState, newState) => {
  if (oldState.theme === newState.theme) {
    return Mvu.Cmd.none();
  }

  return Mvu.Cmd.batch(
    Mvu.Cmd.of<Cmd>({ kind: "ApplyTheme", theme: newState.theme }),
    Mvu.Cmd.of<Cmd>({ kind: "SaveSettings", settings: toCachedSettings(newState) }),
  );
};

const syncReactor: Mvu.Reactor<State, Cmd> = (oldState, newState) => {
  if (oldState.syncingTheme === newState.syncingTheme || newState.syncingTheme === null) {
    return Mvu.Cmd.none();
  }

  return Mvu.Cmd.of({
    kind: "SyncTheme",
    theme: newState.syncingTheme,
    userId: newState.userId,
  });
};

const reactor = Mvu.combineReactors([themeReactor, syncReactor]);

export const update = (msg: Msg, state: State): Mvu.Transition<State, Cmd> => {
  const [newState, updateCmd] = localUpdate(msg, state);
  return [newState, Mvu.Cmd.batch(updateCmd, reactor(state, newState))];
};

export const initialCommands = (state: State): Mvu.Cmd<Cmd> => {
  return [
    { kind: "ApplyTheme", theme: state.theme },
    { kind: "SaveSettings", settings: toCachedSettings(state) },
    { kind: "LoadRemote", expectedTheme: state.theme, userId: state.userId },
  ];
};

export const runCmd = (cmd: Cmd, send: (msg: Msg) => void) => {
  switch (cmd.kind) {
    case "LoadRemote": {
      void loadRemoteSettings(cmd.userId, cmd.expectedTheme, send);
      return;
    }
    case "SaveSettings": {
      Cache.writeCachedSettings(cmd.settings);
      return;
    }
    case "SyncTheme": {
      void syncTheme(cmd.userId, cmd.theme, send);
      return;
    }
    case "ApplyTheme": {
      applyTheme(cmd.theme);
      return;
    }
  }
};

const loadRemoteSettings = async (
  userId: string,
  expectedTheme: Theme,
  send: (msg: Msg) => void,
) => {
  const { data, error } = await api.GET("/api/settings");
  if (error || data === undefined) {
    return;
  }

  send({ kind: "RemoteLoaded", expectedTheme, theme: data.theme, userId });
};

const syncTheme = async (userId: string, theme: Theme, send: (msg: Msg) => void) => {
  const { data, error } = await api.PUT("/api/settings", { body: { theme } });
  if (error || data === undefined) {
    send({ kind: "ThemeSyncFailed", theme, userId });
    return;
  }

  send({ kind: "ThemeSynced", theme, userId });
};

export const applyTheme = (theme: Theme) => {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }

  document.documentElement.setAttribute("data-theme", theme);
};
