import { render } from "solid-js/web";
import "./global.css";
import App from "./App";
import * as Session from "./session";
import { documentClass, mountClass } from "./styles/base.stylex";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found");
}

document.documentElement.classList.add(...documentClass.split(/\s+/));
rootElement.className = mountClass;
Session.start();

render(() => <App />, rootElement);
