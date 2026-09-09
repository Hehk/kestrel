import { Select } from "@kobalte/core/select";
import * as stylex from "@stylexjs/stylex";
import { appStore, send } from "./store";
import { Button } from "./components/Button";
import { PageLayout } from "./components/PageLayout";
import * as Settings from "./settingsSlice";
import { styles as baseStyles } from "./styles/base";
import { tokens } from "./styles/tokens.stylex";

const styles = stylex.create({
  pageCardHeading: {
    marginTop: 0,
  },
  form: {
    display: "grid",
    gap: "0.85rem",
    justifyItems: "start",
  },
  error: {
    color: tokens.textMuted,
  },
  label: {
    marginBottom: "0.25rem",
    fontWeight: 700,
  },
  value: {
    textAlign: "left",
  },
  popup: {
    zIndex: 10,
    minWidth: "var(--kb-popper-anchor-width)",
    padding: "0.25rem",
    color: tokens.text,
    backgroundColor: tokens.background,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: tokens.border,
    boxShadow: "0 0.35rem 1.25rem rgb(0 0 0 / 18%)",
    outline: "none",
  },
  list: {
    display: "grid",
    gap: "0.1rem",
    outline: "none",
  },
  item: {
    display: "flex",
    alignItems: "center",
    gap: "0.45rem",
    paddingBlock: "0.25rem",
    paddingInline: "0.45rem",
    outline: "none",
    cursor: "default",
    color: { default: null, "[data-highlighted]": tokens.background },
    backgroundColor: { default: null, "[data-highlighted]": tokens.text },
  },
  indicator: {
    width: "1rem",
  },
  itemText: {
    flexGrow: 1,
    flexBasis: "0%",
  },
});
import DefaultHeader from "./DefaultHeader";
import { CaretUpDownIcon, CheckIcon } from "./icons/Icons";

const themes: Array<{ label: string; value: Settings.Theme }> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

const ThemeSelect = () => {
  const theme = appStore((state) => state.settings.theme);
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
        <Select.Item {...stylex.attrs(styles.item)} item={props.item}>
          <Select.ItemIndicator {...stylex.attrs(styles.indicator)}>
            <CheckIcon />
          </Select.ItemIndicator>
          <Select.ItemLabel {...stylex.attrs(styles.itemText)}>
            {props.item.rawValue.label}
          </Select.ItemLabel>
        </Select.Item>
      )}
    >
      <Select.Label {...stylex.attrs(styles.label)}>Theme</Select.Label>
      <Select.Trigger as={Button} variant="select">
        <Select.Value<(typeof themes)[number]> {...stylex.attrs(styles.value)}>
          {(state) => state.selectedOption().label}
        </Select.Value>
        <Select.Icon>
          <CaretUpDownIcon />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content {...stylex.attrs(styles.popup)}>
          <Select.Listbox {...stylex.attrs(styles.list)} />
        </Select.Content>
      </Select.Portal>
    </Select>
  );
};

export const SettingsPage = () => {
  const themeSyncError = appStore((state) => state.settings.themeSyncError);

  return (
    <PageLayout header={<DefaultHeader />}>
      <h1 {...stylex.attrs(baseStyles.heading, baseStyles.heading1, styles.pageCardHeading)}>
        Settings
      </h1>
      <div {...stylex.attrs(styles.form)}>
        <ThemeSelect />
        {themeSyncError() ? (
          <p {...stylex.attrs(baseStyles.paragraph, styles.error)}>
            Theme is saved on this device but has not synced.{" "}
            <Button
              onClick={() => send({ kind: "Settings", msg: { kind: "ThemeSyncRetryRequested" } })}
            >
              Retry
            </Button>
          </p>
        ) : null}
      </div>
    </PageLayout>
  );
};
