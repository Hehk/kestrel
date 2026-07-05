import { Select } from "@base-ui/react/select";
import { useModel, send } from "./model";
import * as Settings from "./settingsSlice";

function CaretUpDownIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      style={{ display: "block", ...props.style }}
    >
      <path d="M11 10H5l3 3.5zm0-4H5l3-3.5z" />
    </svg>
  );
}

function CheckIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      {...props}
      style={{ display: "block", ...props.style }}
    >
      <path d="m2.5 8.5 4 4 7-9" />
    </svg>
  );
}

function CaretUpIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      style={{ display: "block", ...props.style }}
    >
      <path d="M12 10H4l4-4.5z" />
    </svg>
  );
}

function CaretDownIcon(props: React.ComponentProps<"svg">) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      {...props}
      style={{ display: "block", ...props.style }}
    >
      <path d="M12 6H4l4 4.5z" />
    </svg>
  );
}

type LoadedSettings = Extract<Settings.State, { status: "loaded" }>;

const themes: Array<{ label: string; value: Settings.Theme }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const ThemeSelect = ({ settings }: { settings: LoadedSettings }) => {
  return (
    <Select.Root
      items={themes}
      name="theme"
      value={settings.theme}
      onValueChange={(value) => {
        if (value !== null) {
          send({ kind: "Settings", msg: { kind: "ThemeChanged", theme: value } });
        }
      }}
    >
      <Select.Label className="select-label">Theme</Select.Label>
      <Select.Trigger className="theme-select-trigger">
        <Select.Value className="select-value" />
        <Select.Icon>
          <CaretUpDownIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner
          className="select-positioner"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="select-popup">
            <Select.ScrollUpArrow className="select-scroll-arrow">
              <CaretUpIcon />
            </Select.ScrollUpArrow>
            <Select.List className="select-list">
              {themes.map(({ label, value }) => (
                <Select.Item key={value} value={value} className="select-item">
                  <Select.ItemIndicator className="select-item-indicator">
                    <CheckIcon />
                  </Select.ItemIndicator>
                  <Select.ItemText className="select-item-text">{label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
            <Select.ScrollDownArrow className="select-scroll-arrow">
              <CaretDownIcon />
            </Select.ScrollDownArrow>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
};

export const SettingsPage = () => {
  const settings = useModel((model) => model.get("settings"));

  return (
    <section className="page-card">
      <h1>Settings</h1>
      {settings.status === "loading" ? (
        <p>Loading settings...</p>
      ) : settings.status === "error" ? (
        <p>Settings could not be loaded. Try refreshing the page.</p>
      ) : (
        <div className="settings-form">
          <ThemeSelect settings={settings} />
          {settings.themeSyncStatus === "error" ? (
            <p className="settings-error">
              Theme could not be saved. Reverted to last saved theme.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
};
