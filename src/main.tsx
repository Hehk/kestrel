import { render } from "solid-js/web";
import "./global.css";
import App from "./App";
import * as Session from "./session";
import { bodyClass, documentClass, mountClass } from "./styles/base";

const rootElement = document.getElementById("root");

if (rootElement === null) {
  throw new Error("Root element #root was not found");
}

document.documentElement.classList.add(...documentClass.split(/\s+/));
document.body.classList.add(...bodyClass.split(/\s+/));
rootElement.className = mountClass;
Session.start();

render(() => <App />, rootElement);
