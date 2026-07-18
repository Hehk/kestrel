import { Select } from "@kobalte/core/select";
import { useModel, send } from "./model";
import * as Settings from "./settingsSlice";
import DefaultHeader from "./DefaultHeader";
import { CaretUpDownIcon, CheckIcon } from "./icons/Icons";

const themes: Array<{ label: string; value: Settings.Theme }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const ThemeSelect = () => {
  const theme = useModel((model) => model.settings.theme);
  const selectedTheme = () => themes.find((option) => option.value === theme()) ?? themes[0]!;

  return (
    <Select<(typeof themes)[number]>
      gutter={4}
      multiple={false}
      name="theme"
      options={themes}
      optionTextValue="label"
      optionValue="value"
      value={selectedTheme()}
      onChange={(option) => {
        const value = option?.value;
        if (value !== undefined) {
          send({ kind: "Settings", msg: { kind: "ThemeChanged", theme: value } });
        }
      }}
      itemComponent={(props) => (
        <Select.Item className="select-item" item={props.item}>
          <Select.ItemIndicator className="select-item-indicator">
            <CheckIcon />
          </Select.ItemIndicator>
          <Select.ItemLabel className="select-item-text">
            {props.item.rawValue.label}
          </Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Select.Label className="select-label">Theme</Select.Label>
      <Select.Trigger className="theme-select-trigger">
        <Select.Value<(typeof themes)[number]> className="select-value">
          {(state) => state.selectedOption().label}
        </Select.Value>
        <Select.Icon>
          <CaretUpDownIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-popup select-positioner">
          <Select.Listbox className="select-list" />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
};

export const SettingsPage = () => {
  const themeSyncError = useModel((model) => model.settings.themeSyncError);

  return (
    <div className="default-page">
      <DefaultHeader />
      <section className="page-card">
        <h1>Settings</h1>
        <div className="settings-form">
          <ThemeSelect />
          {themeSyncError() ? (
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
