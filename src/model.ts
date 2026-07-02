import { Record } from "immutable";
import { useSyncExternalStore } from "react";
import { api } from "./api/client";
import * as Cache from "./cache";
import * as Router from "./router";

export type User = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
};

export type Theme = "dark" | "light" | "system";

export type SettingsState =
  | {
    status: "loading";
  }
  | {
    status: "loaded";
    theme: Theme;
    draftTheme: Theme;
    saveStatus: "idle" | "saving" | "saved" | "error";
  }
  | {
    status: "error";
  };

export type Model = Record<{
  count: number;
  route: Router.AuthenticatedRoute;
  settings: SettingsState;
  user: User;
}>;

export type Cmd =
  | {
    kind: "Navigate";
    route: Router.ProtectedRoute;
    replace: boolean;
  }
  | {
    kind: "SettingsLoad";
  }
  | {
    kind: "SettingsSave";
    theme: Theme;
  }
  | {
    kind: "ThemeApply";
    theme: Theme;
  };

type UpdateContext = {
  runCmd: (cmd: Cmd) => void;
};

export type Msg =
  | { kind: "CountIncrement" }
  | { kind: "CountDecrement" }
  | { kind: "RouteRequested"; route: Router.ProtectedRoute; replace: boolean }
  | { kind: "RouteChanged"; route: Router.Route }
  | { kind: "SettingsLoadRequested" }
  | { kind: "SettingsLoaded"; theme: Theme }
  | { kind: "SettingsLoadFailed" }
  | { kind: "SettingsThemeChanged"; theme: Theme }
  | { kind: "SettingsSaveRequested" }
  | { kind: "SettingsSaved"; theme: Theme }
  | { kind: "SettingsSaveFailed" }
  | { kind: "UserRefreshed"; user: User };

const settingsFromCache = (userId: string): SettingsState => {
  const theme = Cache.readCachedSettings(userId);
  if (theme === null) {
    return { status: "loading" };
  }

  return {
    status: "loaded",
    theme,
    draftTheme: theme,
    saveStatus: "idle",
  };
};

const createModel = (user: User, route: Router.AuthenticatedRoute): Model => {
  return Record({
    count: 0,
    route,
    settings: settingsFromCache(user.id),
    user,
  })();
};

export const update = (ctx: UpdateContext, msg: Msg, model: Model): Model => {
  switch (msg.kind) {
    case "CountIncrement": {
      const oldCount = model.get("count");
      return model.set("count", oldCount + 1);
    }
    case "CountDecrement": {
      const oldCount = model.get("count");
      return model.set("count", oldCount - 1);
    }
    case "RouteRequested": {
      if (Router.equal(model.get("route"), msg.route)) {
        return model;
      }

      ctx.runCmd({ kind: "Navigate", route: msg.route, replace: msg.replace });
      return model;
    }
    case "RouteChanged": {
      const route = Router.toAuthenticatedRoute(msg.route);
      if (msg.route.name === "Login") {
        ctx.runCmd({ kind: "Navigate", route: { name: "Home" }, replace: true });
      }

      if (Router.equal(model.get("route"), route)) {
        return model;
      }

      return model.set("route", route);
    }
    case "SettingsLoadRequested": {
      ctx.runCmd({ kind: "SettingsLoad" });
      return model.set("settings", { status: "loading" });
    }
    case "SettingsLoaded": {
      const user = model.get("user");
      Cache.writeCachedSettings(user.id, msg.theme);
      ctx.runCmd({ kind: "ThemeApply", theme: msg.theme });
      return model.set("settings", {
        status: "loaded",
        theme: msg.theme,
        draftTheme: msg.theme,
        saveStatus: "idle",
      });
    }
    case "SettingsLoadFailed": {
      if (model.get("settings").status === "loaded") {
        return model;
      }

      return model.set("settings", { status: "error" });
    }
    case "SettingsThemeChanged": {
      const settings = model.get("settings");
      if (settings.status !== "loaded") {
        return model;
      }

      return model.set("settings", { ...settings, draftTheme: msg.theme, saveStatus: "idle" });
    }
    case "SettingsSaveRequested": {
      const settings = model.get("settings");
      if (settings.status !== "loaded") {
        return model;
      }

      ctx.runCmd({ kind: "SettingsSave", theme: settings.draftTheme });
      return model.set("settings", { ...settings, saveStatus: "saving" });
    }
    case "SettingsSaved": {
      const user = model.get("user");
      Cache.writeCachedSettings(user.id, msg.theme);
      ctx.runCmd({ kind: "ThemeApply", theme: msg.theme });
      return model.set("settings", {
        status: "loaded",
        theme: msg.theme,
        draftTheme: msg.theme,
        saveStatus: "saved",
      });
    }
    case "SettingsSaveFailed": {
      const settings = model.get("settings");
      if (settings.status !== "loaded") {
        return model.set("settings", { status: "error" });
      }

      return model.set("settings", { ...settings, saveStatus: "error" });
    }
    case "UserRefreshed": {
      if (model.get("user").id === msg.user.id) {
        return model.set("user", msg.user);
      }

      return createModel(msg.user, model.get("route"));
    }
  }
};

let model: Model | null = null;
let subs: Set<() => void> = new Set();

const defaultRunCmd = (cmd: Cmd) => {
  switch (cmd.kind) {
    case "Navigate": {
      Router.navigate(cmd.route, { replace: cmd.replace });
      send({ kind: "RouteChanged", route: cmd.route });
      return;
    }
    case "SettingsLoad": {
      void loadSettings();
      return;
    }
    case "SettingsSave": {
      void saveSettings(cmd.theme);
      return;
    }
    case "ThemeApply": {
      applyTheme(cmd.theme);
      return;
    }
  }
};

const loadSettings = async () => {
  const { data, error } = await api.GET("/api/settings");
  if (error || data === undefined) {
    send({ kind: "SettingsLoadFailed" });
    return;
  }

  send({ kind: "SettingsLoaded", theme: data.theme });
};

const saveSettings = async (theme: Theme) => {
  const { data, error } = await api.PUT("/api/settings", { body: { theme } });
  if (error || data === undefined) {
    send({ kind: "SettingsSaveFailed" });
    return;
  }

  send({ kind: "SettingsSaved", theme: data.theme });
};

const applyTheme = (theme: Theme) => {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
    return;
  }

  document.documentElement.setAttribute("data-theme", theme);
};

let runCmd = defaultRunCmd;

export const start = (
  user: User,
  route: Router.AuthenticatedRoute = Router.toAuthenticatedRoute(Router.getRoute()),
) => {
  model = createModel(user, route);
  subs.forEach((sub) => sub());

  const settings = model.get("settings");
  if (settings.status === "loaded") {
    runCmd({ kind: "ThemeApply", theme: settings.theme });
  }

  if (Router.getRoute().name === "Login" && route.name !== "NotFound") {
    runCmd({ kind: "Navigate", route, replace: true });
  }

  runCmd({ kind: "SettingsLoad" });
};

export const stop = () => {
  model = null;
  subs.forEach((sub) => sub());
};

export const send = (msg: Msg) => {
  if (model === null) {
    throw new Error("Authenticated model was updated before a user was available");
  }

  const cmds: Cmd[] = [];
  const ctx: UpdateContext = {
    runCmd: (cmd) => {
      cmds.push(cmd);
    },
  };

  model = update(ctx, msg, model);
  subs.forEach((sub) => sub());
  cmds.forEach((cmd) => runCmd(cmd));
};

Router.onStateChange((route) => {
  if (model !== null) {
    send({ kind: "RouteChanged", route });
  }
});

const subscribe = (onStoreChange: () => void) => {
  subs.add(onStoreChange);
  return () => subs.delete(onStoreChange);
};

export const useModel = <A>(selector: (model: Model) => A) => {
  return useSyncExternalStore(subscribe, () => {
    if (model === null) {
      throw new Error("Authenticated model was read before a user was available");
    }

    return selector(model);
  });
};

export const get = (): Model => {
  if (model === null) {
    throw new Error("Authenticated model was read before a user was available");
  }

  return model;
};

// NOTE: I am not 100% about these, testing patterns but once we are using the commands
// more, I will probably want to refactor them.
export const setRunCmdForTest = (nextRunCmd: (cmd: Cmd) => void) => {
  runCmd = nextRunCmd;
  return () => {
    runCmd = defaultRunCmd;
  };
};

// NOTE: I am not 100% about these, testing patterns but once we are using the commands
// more, I will probably want to refactor them.
export const resetForTest = () => {
  model = null;
  subs = new Set();
  runCmd = defaultRunCmd;
};
