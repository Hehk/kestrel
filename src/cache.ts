import type { User } from "./store";
import type { Theme } from "./settingsSlice";

const SESSION_KEY = "kestrel.session";
const SETTINGS_KEY_PREFIX = "kestrel.settings.";

type CachedSession = {
  version: 1;
  user: User;
};

export type CachedSettings = {
  version: 1;
  userId: string;
  theme: Theme;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null;
};

const isTheme = (value: unknown): value is Theme => {
  return value === "dark" || value === "light" || value === "system";
};

const isUser = (value: unknown): value is User => {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["displayName"] === "string" &&
    (value["avatarUrl"] === undefined ||
      value["avatarUrl"] === null ||
      typeof value["avatarUrl"] === "string")
  );
};

const parseJson = (value: string | null): unknown => {
  if (value === null) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
};

const settingsKey = (userId: string) => `${SETTINGS_KEY_PREFIX}${userId}`;

export const readCachedUser = (): User | null => {
  const value = parseJson(window.localStorage.getItem(SESSION_KEY));
  if (!isRecord(value) || value["version"] !== 1 || !isUser(value["user"])) {
    return null;
  }

  return value["user"];
};

export const writeCachedUser = (user: User) => {
  const value: CachedSession = { version: 1, user };
  window.localStorage.setItem(SESSION_KEY, JSON.stringify(value));
};

export const clearCachedUser = () => {
  window.localStorage.removeItem(SESSION_KEY);
};

export const readCachedSettings = (userId: string): CachedSettings | null => {
  const value = parseJson(window.localStorage.getItem(settingsKey(userId)));
  if (
    !isRecord(value) ||
    (value["version"] !== 1 && value["version"] !== 2) ||
    value["userId"] !== userId ||
    !isTheme(value["theme"])
  ) {
    return null;
  }

  return {
    version: 1,
    userId,
    theme: value["theme"],
  };
};

export const writeCachedSettings = (settings: CachedSettings) => {
  window.localStorage.setItem(settingsKey(settings.userId), JSON.stringify(settings));
};

export const clearCachedSettings = (userId: string) => {
  window.localStorage.removeItem(settingsKey(userId));
};
