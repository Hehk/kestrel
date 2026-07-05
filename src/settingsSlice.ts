import { api } from "./api/client";
import * as Cache from "./cache";

export type Theme = "dark" | "light" | "system";
export const DEFAULT_THEME: Theme = "system";

// This code is already showing some of the weirdness of keeping data in sync with the
// backend. I am going to iterate on a few different patterns as this comes up later on
// or even in the settings. Hopefully after a few iterations I have a good interface and then
// a real nice sync pattern can be implemented.

export type State =
  | {
    status: "loading";
  }
  | {
    status: "loaded";
    theme: Theme;
    confirmedTheme: Theme;
    themeSaveRequestId: number;
    themeSyncStatus: "idle" | "saving" | "error";
  }
  | {
    status: "error";
  };

export type Cmd =
  | {
    kind: "Load";
  }
  | {
    kind: "SaveTheme";
    requestId: number;
    theme: Theme;
  }
  | {
    kind: "ApplyTheme";
    theme: Theme;
  };

export type Msg =
  // This one is never actually used...
  | { kind: "LoadRequested" }
  | { kind: "Loaded"; theme: Theme }
  | { kind: "LoadFailed" }
  | { kind: "ThemeChanged"; theme: Theme }
  | { kind: "ThemeSaved"; requestId: number; theme: Theme }
  | { kind: "ThemeSaveFailed"; requestId: number };

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
  userId: string;
};

const loadedState = (theme: Theme): State => {
  return {
    status: "loaded",
    theme,
    confirmedTheme: theme,
    themeSaveRequestId: 0,
    themeSyncStatus: "idle",
  };
};

export const fromCache = (userId: string): State => {
  const theme = Cache.readCachedSettings(userId);
  if (theme === null) {
    return { status: "loading" };
  }

  return loadedState(theme);
};

export const update = (ctx: UpdateContext, msg: Msg, state: State): State => {
  switch (msg.kind) {
    case "LoadRequested": {
      ctx.runCmd({ kind: "Load" });
      return state.status === "loaded" ? state : { status: "loading" };
    }
    case "Loaded": {
      if (state.status === "loaded" && state.themeSyncStatus === "saving") {
        return { ...state, confirmedTheme: msg.theme };
      }

      Cache.writeCachedSettings(ctx.userId, msg.theme);
      // TODO: There should be a kind of subscription to the theme slice that checks if the
      // theme changed then it adds the command to the queue. This way we don't need to do this
      // check constantly
      ctx.runCmd({ kind: "ApplyTheme", theme: msg.theme });
      return loadedState(msg.theme);
    }
    case "LoadFailed": {
      return state.status === "loaded" ? state : { status: "error" };
    }
    case "ThemeChanged": {
      if (state.status !== "loaded" || state.theme === msg.theme) {
        return state;
      }

      const requestId = state.themeSaveRequestId + 1;
      Cache.writeCachedSettings(ctx.userId, msg.theme);
      ctx.runCmd({ kind: "ApplyTheme", theme: msg.theme });
      ctx.runCmd({ kind: "SaveTheme", requestId, theme: msg.theme });
      return {
        ...state,
        theme: msg.theme,
        themeSaveRequestId: requestId,
        themeSyncStatus: "saving",
      };
    }
    case "ThemeSaved": {
      // This solution has issues. If say you have two requests, a then b, if b fails
      // then neither will be committed to the frontend
      if (state.status !== "loaded" || state.themeSaveRequestId !== msg.requestId) {
        return state;
      }

      Cache.writeCachedSettings(ctx.userId, msg.theme);
      ctx.runCmd({ kind: "ApplyTheme", theme: msg.theme });
      return {
        ...state,
        theme: msg.theme,
        confirmedTheme: msg.theme,
        themeSyncStatus: "idle",
      };
    }
    case "ThemeSaveFailed": {
      if (state.status !== "loaded" || state.themeSaveRequestId !== msg.requestId) {
        return state;
      }

      Cache.writeCachedSettings(ctx.userId, state.confirmedTheme);
      ctx.runCmd({ kind: "ApplyTheme", theme: state.confirmedTheme });
      return {
        ...state,
        theme: state.confirmedTheme,
        themeSyncStatus: "error",
      };
    }
  }
};

export const runCmd = (cmd: Cmd, send: (msg: Msg) => void) => {
  switch (cmd.kind) {
    case "Load": {
      void loadSettings(send);
      return;
    }
    case "SaveTheme": {
      void saveTheme(cmd.theme, cmd.requestId, send);
      return;
    }
    case "ApplyTheme": {
      applyTheme(cmd.theme);
      return;
    }
  }
};

const loadSettings = async (send: (msg: Msg) => void) => {
  const { data, error } = await api.GET("/api/settings");
  if (error || data === undefined) {
    send({ kind: "LoadFailed" });
    return;
  }

  send({ kind: "Loaded", theme: data.theme });
};

const saveTheme = async (theme: Theme, requestId: number, send: (msg: Msg) => void) => {
  const { data, error } = await api.PUT("/api/settings", { body: { theme } });
  if (error || data === undefined) {
    send({ kind: "ThemeSaveFailed", requestId });
    return;
  }

  send({ kind: "ThemeSaved", requestId, theme: data.theme });
};

export const applyTheme = (theme: Theme) => {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }

  document.documentElement.setAttribute("data-theme", theme);
};
