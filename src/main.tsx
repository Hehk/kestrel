import { render } from "solid-js/web";
import "./index.css";
import App from "./App";
import * as Session from "./session";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found");
}

Session.start();

render(() => <App />, rootElement);
