# Shared components

Keep reusable presentation here and feature-specific components with their feature. Import components directly from their files.

- `Button` renders a native button and defaults to `type="button"`. Use `type="submit"` explicitly for form submission.
- `Anchor` renders a native anchor. Use `src/Link.tsx` for authenticated app navigation; it reuses `Anchor` while keeping routing separate. `variant="navigation"` keeps visited navigation links the same color.
- `PageLayout` provides the standard narrow page container, a `header` slot, and a content section. It does not add a `main` landmark or own authentication/navigation.
- `SiteHeader` provides the site title and primary navigation shell. Pass navigation children appropriate to the session.

Pass StyleX overrides as `xstyle`, not generated classes, so the component can compose them after its base styles:

```tsx
<Button xstyle={styles.action} onClick={save}>Save</Button>
<Anchor href={url} xstyle={[styles.action, active() && styles.active]}>View</Anchor>
<Tooltip.Trigger as={Button} xstyle={styles.iconAction} aria-label="Sync">
  <SyncIcon />
</Tooltip.Trigger>
```

Native props, refs, and events are forwarded. `class` remains available for integration with other libraries, not for resolving StyleX overrides. Compose Kobalte triggers through `as` to retain their keyboard, focus, and ARIA behavior without nesting interactive elements.
