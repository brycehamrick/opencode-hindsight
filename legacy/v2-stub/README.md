# @brycehamrick/opencode-v2-hindsight (renamed)

**This package has been renamed to
[@brycehamrick/opencode-hindsight](https://www.npmjs.com/package/@brycehamrick/opencode-hindsight).**

This is a forwarding stub kept alive so existing configs don't break. It:

- re-exports the real plugin (depends on `^0.3.0`), so it stays functional, and
- prints a migration warning on load.

## Migrate

In your opencode config, change:

```jsonc
{ "package": "@brycehamrick/opencode-v2-hindsight" }
```

to:

```jsonc
{ "package": "@brycehamrick/opencode-hindsight" }
```

Options are unchanged — everything the old package accepted is accepted by the
new one. See the new package's README for the full configuration reference.

## Why not unpublish?

npm's 72-hour unpublish window has long passed, and pulling a package other
people may depend on is against registry policy. The deprecation notice on all
old versions plus this stub is the standard migration path.
