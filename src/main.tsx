import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import * as Session from "./session";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found");
}

Session.start();

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
