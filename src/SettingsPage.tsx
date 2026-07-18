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
        <Select.Item class="select-item" item={props.item}>
          <Select.ItemIndicator class="select-item-indicator">
            <CheckIcon />
          </Select.ItemIndicator>
          <Select.ItemLabel class="select-item-text">{props.item.rawValue.label}</Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Select.Label class="select-label">Theme</Select.Label>
      <Select.Trigger class="theme-select-trigger">
        <Select.Value<(typeof themes)[number]> class="select-value">
          {(state) => state.selectedOption().label}
        </Select.Value>
        <Select.Icon>
          <CaretUpDownIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content class="select-popup select-positioner">
          <Select.Listbox class="select-list" />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
};

export const SettingsPage = () => {
  const themeSyncError = useModel((model) => model.settings.themeSyncError);

  return (
    <div class="default-page">
      <DefaultHeader />
      <section class="page-card">
        <h1>Settings</h1>
        <div class="settings-form">
          <ThemeSelect />
          {themeSyncError() ? (
            <p class="settings-error">
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
