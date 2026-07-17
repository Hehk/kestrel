import { Select } from "@base-ui/react/select";
import { useModel, send } from "./model";
import * as Settings from "./settingsSlice";
import DefaultHeader from "./DefaultHeader";
import { CaretDownIcon, CaretUpDownIcon, CaretUpIcon, CheckIcon } from "./icons/Icons";

const themes: Array<{ label: string; value: Settings.Theme }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const ThemeSelect = () => {
  const theme = useModel((model) => model.get("settings").theme);

  return (
    <Select.Root
      items={themes}
      name="theme"
      value={theme}
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
  const themeSyncError = useModel((model) => model.get("settings").themeSyncError);

  return (
    <div className="default-page">
      <DefaultHeader />
      <section className="page-card">
        <h1>Settings</h1>
        <div className="settings-form">
          <ThemeSelect />
          {themeSyncError ? (
            <p className="settings-error">
              Theme is saved on this device but has not synced.{" "}
              <button
                onClick={() => send({ kind: "Settings", msg: { kind: "ThemeSyncRetryRequested" } })}
                type="button"
              >
                Retry
              </button>
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
};
