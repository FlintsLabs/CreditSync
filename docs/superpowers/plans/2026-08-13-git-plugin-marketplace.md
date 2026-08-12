# Git-backed CreditSync Plugin Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `FlintsLabs/CreditSync` addable as a Git-backed Codex marketplace whose `main` snapshot exposes the CreditSync plugin at `plugins/creditsync` with a documented refresh and reinstall flow.

**Architecture:** Keep the existing plugin package and repository marketplace layout, but give the marketplace the stable identifier `creditsync-marketplace`. Extend the plugin contract test and validator so the repository-relative path, policies, category, unique entry, referenced directory, and nested plugin name cannot drift. Document initial Git installation and explicit snapshot refresh/reinstall commands without changing private-app authentication.

**Tech Stack:** JSON marketplace manifest, Bun/TypeScript tests and validator, Markdown operator documentation, Codex plugin CLI.

## Global Constraints

- Marketplace manifest is `.agents/plugins/marketplace.json`.
- Marketplace name is exactly `creditsync-marketplace`.
- Plugin source is exactly `./plugins/creditsync` and resolves inside the Git marketplace snapshot.
- Git source is `FlintsLabs/CreditSync` and the default tracked ref is `main`.
- Updates require marketplace upgrade, plugin reinstall, and a new Codex task; they are not hot reloads.
- Do not store bearer credentials, signed URLs, private app secrets, or environment files in the marketplace.
- Preserve the existing private `.app.json` authentication boundary.
- Do not stage or modify the user's unrelated frontend work.

---

### Task 1: Freeze the Git marketplace contract

**Files:**
- Modify: `.agents/plugins/marketplace.json`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`

**Interfaces:**
- Consumes: Codex repository marketplace schema and `plugins/creditsync/.codex-plugin/plugin.json`.
- Produces: a marketplace named `creditsync-marketplace` containing one exact `creditsync` local-source entry.

- [ ] **Step 1: Strengthen the marketplace contract test before changing the manifest**

Replace the marketplace assertion with checks for the complete root contract, one exact plugin entry, resolved plugin directory existence, and nested manifest name:

```ts
expect(marketplace).toEqual({
    name: "creditsync-marketplace",
    interface: { displayName: "CreditSync" },
    plugins: [{
        name: "creditsync",
        source: { source: "local", path: "./plugins/creditsync" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
    }],
});
expect(existsSync(resolve(repositoryRoot, "plugins/creditsync"))).toBe(true);
const referencedManifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "plugins/creditsync/.codex-plugin/plugin.json"), "utf8"),
) as { name?: string };
expect(referencedManifest.name).toBe("creditsync");
```

- [ ] **Step 2: Run the focused test and verify the old marketplace name fails**

Run: `bun test plugins/creditsync/tests/plugin-contract.test.ts`

Expected: FAIL because the manifest still declares `name: "personal"` and `displayName: "Personal"`.

- [ ] **Step 3: Apply the stable marketplace identity**

Change only the marketplace root metadata:

```json
{
  "name": "creditsync-marketplace",
  "interface": {
    "displayName": "CreditSync"
  }
}
```

Keep the exact existing plugin entry and its relative source path.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `bun test plugins/creditsync/tests/plugin-contract.test.ts`

Expected: PASS for all plugin contract tests.

### Task 2: Enforce marketplace integrity in package validation

**Files:**
- Modify: `plugins/creditsync/scripts/validate.ts`
- Test: `plugins/creditsync/tests/plugin-contract.test.ts`

**Interfaces:**
- Consumes: parsed marketplace JSON and the plugin manifest at the declared repository-relative source.
- Produces: actionable validation errors for root metadata, entry cardinality/content, missing source directories, or nested manifest-name mismatch.

- [ ] **Step 1: Add exported marketplace validation coverage**

Refactor the marketplace block into an exported pure helper:

```ts
export function validateMarketplaceContract(
    marketplace: Record<string, unknown>,
    sourceDirectoryExists: boolean,
    sourceManifestName: unknown,
): string[]
```

Add tests proving it rejects `name: "personal"`, duplicate CreditSync entries, a changed source path, a missing directory, and a nested manifest name other than `creditsync`.

- [ ] **Step 2: Run the focused tests and verify the helper is initially missing**

Run: `bun test plugins/creditsync/tests/plugin-contract.test.ts`

Expected: FAIL because `validateMarketplaceContract` is not exported.

- [ ] **Step 3: Implement exact validation and wire it into `validatePlugin`**

The helper returns exact error strings and checks:

```ts
marketplace.name === "creditsync-marketplace"
marketplace.interface.displayName === "CreditSync"
marketplace.plugins.length === 1
entry.name === "creditsync"
entry.source.source === "local"
entry.source.path === "./plugins/creditsync"
entry.policy.installation === "AVAILABLE"
entry.policy.authentication === "ON_INSTALL"
entry.category === "Productivity"
sourceDirectoryExists === true
sourceManifestName === "creditsync"
```

Resolve the declared path only after the exact safe relative path check, read its nested manifest, and append helper errors to the existing validation result.

- [ ] **Step 4: Run focused contract tests and the executable validator**

Run:

```bash
bun test plugins/creditsync/tests/plugin-contract.test.ts
bun run plugins/creditsync/scripts/validate.ts
```

Expected: PASS; validator reports plugin 2.3.0, eight skills, 40 tools, and the current private-app registration state.

### Task 3: Document Git installation and update behavior

**Files:**
- Modify: `README.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `CHANGELOG.md`
- Test: `plugins/creditsync/tests/operations-docs.test.ts`

**Interfaces:**
- Consumes: marketplace name `creditsync-marketplace`, Git source `FlintsLabs/CreditSync`, ref `main`, and Codex CLI commands.
- Produces: one consistent initial-install and update runbook in root and plugin documentation.

- [ ] **Step 1: Add documentation assertions**

Extend `operations-docs.test.ts` to require both README files to contain:

```text
codex plugin marketplace add FlintsLabs/CreditSync --ref main
codex plugin add creditsync@creditsync-marketplace
codex plugin marketplace upgrade creditsync-marketplace
```

Also require the plugin README to state that updates are not hot reloads and require a new Codex task after reinstall.

- [ ] **Step 2: Run the documentation tests and verify they fail on local-only instructions**

Run: `bun test plugins/creditsync/tests/operations-docs.test.ts`

Expected: FAIL because current docs use `/absolute/path/to/CreditSync` and `creditsync@personal`.

- [ ] **Step 3: Update both runbooks and changelogs**

Document initial setup:

```bash
codex plugin marketplace add FlintsLabs/CreditSync --ref main
codex plugin add creditsync@creditsync-marketplace
```

Document publishing and client refresh:

```bash
codex plugin marketplace upgrade creditsync-marketplace
codex plugin add creditsync@creditsync-marketplace
```

Explain that Codex resolves `.agents/plugins/marketplace.json` and then `./plugins/creditsync` inside its Git snapshot. State that a push alone does not hot-reload an installed plugin and a new task is required after reinstall. Add concise v0.3.11 and plugin 2.3.0 changelog entries without changing the plugin semantic version because only its distribution metadata and documentation changed.

- [ ] **Step 4: Run documentation tests**

Run: `bun test plugins/creditsync/tests/operations-docs.test.ts`

Expected: PASS.

### Task 4: Validate the complete marketplace package

**Files:**
- Verify: `.agents/plugins/marketplace.json`
- Verify: `plugins/creditsync/`
- Verify: `README.md`
- Verify: `CHANGELOG.md`

**Interfaces:**
- Consumes: all deliverables from Tasks 1-3.
- Produces: a validated repository marketplace ready to add from Git.

- [ ] **Step 1: Run the complete plugin test suite**

Run: `bun test plugins/creditsync/tests`

Expected: PASS with no skipped plugin contract, eval, or documentation test.

- [ ] **Step 2: Run both plugin validators**

Run:

```bash
bun run plugins/creditsync/scripts/validate.ts
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
```

Expected: both validators pass; the private app may truthfully remain `placeholder, non-live`.

- [ ] **Step 3: Validate Git marketplace ingestion without changing user configuration**

Create a disposable temporary configuration directory and run the installed Codex CLI against the repository source, or if the CLI cannot isolate configuration, validate with JSON parsing plus `codex plugin marketplace add --help` rather than altering the user's live marketplace list. Confirm the supported source/ref syntax includes:

```text
owner/repo --ref main
```

- [ ] **Step 4: Check formatting, secrets, and change scope**

Run:

```bash
git diff --check
git diff -- .agents/plugins/marketplace.json plugins/creditsync README.md CHANGELOG.md docs/superpowers
git status --short
```

Expected: no whitespace errors or secrets, and unrelated frontend modifications remain unstaged and unchanged.

- [ ] **Step 5: Commit the marketplace implementation**

Stage only the marketplace, plugin tests/validator/docs, root docs/changelog, and implementation plan, then commit:

```bash
git commit -m "feat(plugin): add git marketplace update flow"
```
