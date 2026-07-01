import createClient from "openapi-fetch";
import type { paths } from "./schema";

export const apiBaseUrl =
  import.meta.env["VITE_API_URL"] ?? (import.meta.env.MODE === "test" ? "http://localhost" : "");

export const apiUrl = (path: string) => {
  return `${apiBaseUrl}${path}`;
};

export const api = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: "include",
  fetch: (...args) => fetch(...args),
});
