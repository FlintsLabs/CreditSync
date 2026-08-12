# Git-backed CreditSync Plugin Marketplace Design

## Goal

Make the CreditSync repository directly addable as a Codex plugin marketplace. A configured Codex installation follows the repository's `main` branch, discovers the CreditSync plugin at a stable in-repository path, and can explicitly refresh and reinstall the plugin after a release is pushed.

## Repository contract

- Marketplace manifest: `.agents/plugins/marketplace.json`
- Marketplace name: `creditsync-marketplace`
- Plugin source: `./plugins/creditsync`
- Plugin manifest: `plugins/creditsync/.codex-plugin/plugin.json`
- Git source: `FlintsLabs/CreditSync`
- Default tracked ref: `main`

The marketplace source path remains relative to the marketplace root. It must not contain a machine-specific absolute path or a second Git URL. Codex checks out the Git marketplace snapshot and resolves `./plugins/creditsync` inside that snapshot.

## Installation and update flow

Initial setup adds the Git repository as a non-default marketplace, optionally using sparse checkout for `.agents` and `plugins/creditsync`, then installs `creditsync@creditsync-marketplace`.

Publishing a plugin update consists of updating the plugin package and its semantic version, validating it, committing it with the project changelog, and pushing it to `main`. Existing Codex installations do not hot-reload on `git push`. They explicitly refresh the configured Git snapshot with `codex plugin marketplace upgrade creditsync-marketplace`, reinstall `creditsync@creditsync-marketplace`, and start a new task so skills and tools are rediscovered.

This design deliberately follows `main`, as approved, rather than pinning a release tag. A broken plugin change on `main` is therefore immediately eligible on the next marketplace refresh. Repository validation is the release gate.

## Validation

The existing plugin validation command will also verify the repository marketplace contract:

- the marketplace name is exactly `creditsync-marketplace`;
- exactly one CreditSync entry is present;
- its source is local and resolves to `./plugins/creditsync`;
- installation and authentication policies remain explicit;
- the referenced directory exists and its plugin manifest name is `creditsync`.

The standard plugin-creator validator remains a second independent manifest check. Tests must not install, remove, or alter the user's configured marketplaces.

## Documentation

The root README will contain a short operator-facing Git marketplace setup and update section. The plugin README will retain package-specific registration requirements and use the same marketplace name and commands. Both documents will distinguish marketplace refresh from plugin reinstall and require a new Codex task after an update.

## Security and secrets

The marketplace contains only plugin metadata and relative source paths. It must not contain bearer credentials, signed URLs, private app secrets, or environment files. The existing `.app.json` private-app reference remains the authentication boundary.

## Out of scope

- Automatic background refresh without a Codex refresh/upgrade action
- GitHub Actions that publish or deploy the CreditSync application
- ChatGPT mobile custom MCP support
- Changing the private MCP app registration or credentials
- Moving the plugin into a separate repository
