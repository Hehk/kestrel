import type { ComponentProps } from "solid-js";

type IconProps = ComponentProps<"svg">;

const iconStyle = (style: IconProps["style"]) => {
  return typeof style === "string" ? `display: block; ${style}` : { display: "block", ...style };
};

export function ArrowLeftIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.5"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M7 3 2 8l5 5M2 8h12" />
    </svg>
  );
}

export function CaretUpDownIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M11 10H5l3 3.5zm0-4H5l3-3.5z" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="m2.5 8.5 4 4 7-9" />
    </svg>
  );
}

export function CaretUpIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M12 10H4l4-4.5z" />
    </svg>
  );
}

export function CaretDownIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M12 6H4l4 4.5z" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-width="1.5"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="m3 3 10 10M13 3 3 13" />
    </svg>
  );
}

export function HourglassIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-linejoin="round"
      stroke-width="1.25"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M4 2.5h8M4 13.5h8M5 2.5v2c0 1.4 1 2.4 3 3.5-2 1.1-3 2.1-3 3.5v2M11 2.5v2c0 1.4-1 2.4-3 3.5 2 1.1 3 2.1 3 3.5v2" />
    </svg>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-linecap="round"
      stroke-width="1.5"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M3 8h10" />
    </svg>
  );
}

export function GitHubIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M8 0a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38l-.01-1.49c-2.23.49-2.7-1.08-2.7-1.08-.37-.93-.9-1.18-.9-1.18-.73-.5.06-.49.06-.49.8.06 1.23.83 1.23.83.72 1.23 1.88.87 2.34.67.07-.52.28-.87.51-1.07-1.78-.2-3.65-.89-3.65-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.64 7.64 0 0 1 8 3.73c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.74.54 1.49l-.01 2.32c0 .21.14.46.55.38A8 8 0 0 0 8 0Z" />
    </svg>
  );
}

export function SyncIcon(props: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={iconStyle(props.style)}
    >
      <path d="M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z" />
    </svg>
  );
}
