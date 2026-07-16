import type { ComponentProps } from "react";

type IconProps = ComponentProps<"svg">;

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
      style={{ display: "block", ...props.style }}
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
      style={{ display: "block", ...props.style }}
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
      style={{ display: "block", ...props.style }}
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
      style={{ display: "block", ...props.style }}
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
      strokeLinecap="round"
      strokeWidth="1.5"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", ...props.style }}
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
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.25"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", ...props.style }}
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
      strokeLinecap="round"
      strokeWidth="1.5"
      {...props}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", ...props.style }}
    >
      <path d="M3 8h10" />
    </svg>
  );
}
