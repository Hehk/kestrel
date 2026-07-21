/// <reference types="vite/client" />

import "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface SvgSVGAttributes<T> {
      focusable?: string | undefined;
    }
  }
}
