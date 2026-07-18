/// <reference types="vite/client" />

import "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface HTMLAttributes<T> {
      className?: string | undefined;
    }

    interface SvgSVGAttributes<T> {
      className?: string | undefined;
      focusable?: string | undefined;
    }
  }
}
