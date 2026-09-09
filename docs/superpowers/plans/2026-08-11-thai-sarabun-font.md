# Thai Sarabun Font Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-host Sarabun and apply it to the entire CreditSync web interface whenever the active application language is Thai.

**Architecture:** Keep language state in i18next and make its bootstrap synchronize the normalized resolved language to the root HTML `lang` attribute. Keep typography declarative in global CSS: four locally built WOFF2 faces provide weights 400–700, and `html:lang(th)` switches the inherited document font without component-specific logic.

**Tech Stack:** React 19, TypeScript 6, i18next 26, Tailwind CSS 4, CSS `@font-face`, Vitest 4, Bun.

## Global Constraints

- Store Sarabun inside `frontend/src/assets/fonts/`; do not load fonts from a CDN at runtime.
- Include normal WOFF2 faces at weights 400, 500, 600, and 700 only.
- Apply Sarabun to Thai-language UI including embedded English text and numbers.
- Preserve the existing system sans-serif behavior for English.
- Keep a system sans-serif fallback and use `font-display: swap`.
- Preserve deliberate monospace utilities.
- Include the upstream SIL Open Font License beside the font assets.
- Use Bun for project commands and `bun x` for the one-off font conversion.
- Every commit must update `CHANGELOG.md` with explicit project version `v0.3.9` and a concise summary.
- Do not stage or commit unrelated existing workspace files.

## File Structure

- Create `frontend/tests/i18n-document-language.test.ts`: focused contract for initial and runtime root-language synchronization.
- Modify `frontend/src/lib/i18n.ts`: normalize supported language tags and synchronize i18next with the root `<html lang>` attribute.
- Create `frontend/tests/thai-font-assets.test.ts`: source-level contract for local WOFF2 files, license, face declarations, and Thai-only selector.
- Create `frontend/src/assets/fonts/Sarabun-{Regular,Medium,SemiBold,Bold}.woff2`: self-hosted full-glyph font faces generated from the official Google Fonts TTF sources.
- Create `frontend/src/assets/fonts/OFL.txt`: upstream Sarabun SIL Open Font License.
- Modify `frontend/src/index.css`: declare the four faces and select Sarabun beneath `html:lang(th)`.
- Modify `CHANGELOG.md`: record each independently testable implementation unit under v0.3.9.

---

### Task 1: Synchronize i18next with the root document language

**Files:**
- Create: `frontend/tests/i18n-document-language.test.ts`
- Modify: `frontend/src/lib/i18n.ts:1-30`
- Modify: `CHANGELOG.md:3-30`

**Interfaces:**
- Consumes: i18next `languageChanged` events and `resolvedLanguage` values such as `en`, `th`, and region-tagged variants.
- Produces: `document.documentElement.lang` normalized to the supported public values `"en" | "th"` at initialization and after every successful language change.

- [ ] **Step 1: Write the failing document-language contract**

Create `frontend/tests/i18n-document-language.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import i18n from "../src/lib/i18n";

describe("i18n document language", () => {
    beforeEach(async () => {
        await i18n.changeLanguage("en");
    });

    afterEach(async () => {
        await i18n.changeLanguage("en");
    });

    it("reflects the initially resolved language on the root element", () => {
        expect(i18n.resolvedLanguage).toBe("en");
        expect(document.documentElement.lang).toBe("en");
    });

    it("updates the normalized root language when the app language changes", async () => {
        await i18n.changeLanguage("th-TH");

        expect(i18n.resolvedLanguage?.startsWith("th")).toBe(true);
        expect(document.documentElement.lang).toBe("th");

        await i18n.changeLanguage("en-US");
        expect(document.documentElement.lang).toBe("en");
    });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
cd frontend && bun test tests/i18n-document-language.test.ts
```

Expected: FAIL because `frontend/index.html` statically initializes `lang="en"` and i18next does not update it after switching to Thai.

- [ ] **Step 3: Implement normalized root-language synchronization**

In `frontend/src/lib/i18n.ts`, add the helper before initialization, register the event before `.init`, and synchronize once after initialization:

```ts
type SupportedLanguage = "en" | "th";

function normalizeLanguage(language?: string): SupportedLanguage {
    return language?.toLowerCase().startsWith("th") ? "th" : "en";
}

function syncDocumentLanguage(language?: string) {
    document.documentElement.lang = normalizeLanguage(language);
}

i18n.on("languageChanged", syncDocumentLanguage);

i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        resources: {
            en: { translation: en },
            th: { translation: th },
        },
        supportedLngs: ["en", "th"],
        nonExplicitSupportedLngs: true,
        fallbackLng: "en",
        debug: true,
        interpolation: {
            escapeValue: false,
        },
    })
    .then(() => syncDocumentLanguage(i18n.resolvedLanguage));
```

Keep the existing default export. The pre-registered listener covers synchronous initial resolution; the `then` call makes post-initialization synchronization explicit.

- [ ] **Step 4: Run the focused and existing preferences tests**

Run:

```bash
cd frontend && bun test tests/i18n-document-language.test.ts tests/account-preferences.vitest.tsx
```

Expected: PASS; the root language changes immediately and Account Preferences still switches localized UI correctly.

- [ ] **Step 5: Record and commit the language synchronization**

Add beneath `## v0.3.9` → `### Changed` in `CHANGELOG.md`:

```markdown
- Synchronized the root HTML language with initial and runtime Thai/English i18next selections so language-dependent typography and accessibility metadata update together.
```

Then run:

```bash
git add frontend/tests/i18n-document-language.test.ts frontend/src/lib/i18n.ts CHANGELOG.md
git diff --cached --check
git commit -m "feat: synchronize document language"
```

Expected: one commit containing only the i18n test, bootstrap change, and changelog entry.

---

### Task 2: Self-host and select the Sarabun font family

**Files:**
- Create: `frontend/tests/thai-font-assets.test.ts`
- Create: `frontend/src/assets/fonts/Sarabun-Regular.woff2`
- Create: `frontend/src/assets/fonts/Sarabun-Medium.woff2`
- Create: `frontend/src/assets/fonts/Sarabun-SemiBold.woff2`
- Create: `frontend/src/assets/fonts/Sarabun-Bold.woff2`
- Create: `frontend/src/assets/fonts/OFL.txt`
- Modify: `frontend/src/index.css:1-75`
- Modify: `CHANGELOG.md:3-30`

**Interfaces:**
- Consumes: the normalized `html[lang="th"]` contract from Task 1 and Tailwind font weights `font-normal`, `font-medium`, `font-semibold`, and `font-bold`.
- Produces: local family `"Sarabun"` at weights 400, 500, 600, and 700; `html:lang(th) body` inherits it while other root languages retain the existing font stack.

- [ ] **Step 1: Write the failing local-font contract**

Create `frontend/tests/thai-font-assets.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const stylesheet = readFileSync(resolve(root, "src/index.css"), "utf8");
const fonts = [
    ["Sarabun-Regular.woff2", 400],
    ["Sarabun-Medium.woff2", 500],
    ["Sarabun-SemiBold.woff2", 600],
    ["Sarabun-Bold.woff2", 700],
] as const;

describe("Thai Sarabun font assets", () => {
    it.each(fonts)("ships valid local %s for weight %i", (filename, weight) => {
        const asset = readFileSync(resolve(root, "src/assets/fonts", filename));
        expect(asset.subarray(0, 4).toString("ascii")).toBe("wOF2");
        expect(stylesheet).toContain(`url("./assets/fonts/${filename}") format("woff2")`);
        expect(stylesheet).toMatch(new RegExp(`font-family:\\s*"Sarabun";[\\s\\S]*?font-weight:\\s*${weight};`));
    });

    it("keeps the redistributable font license beside the assets", () => {
        const license = readFileSync(resolve(root, "src/assets/fonts/OFL.txt"), "utf8");
        expect(license).toContain("SIL OPEN FONT LICENSE Version 1.1");
    });

    it("uses Sarabun only for the Thai document language", () => {
        expect(stylesheet).toMatch(/html:lang\(th\) body\s*\{[^}]*font-family:\s*"Sarabun"/s);
        expect(stylesheet).not.toMatch(/html:lang\(en\)[^{]*\{[^}]*"Sarabun"/s);
        expect(stylesheet.match(/font-display:\s*swap;/g)).toHaveLength(4);
    });
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
cd frontend && bun test tests/thai-font-assets.test.ts
```

Expected: FAIL with `ENOENT` because the local font directory and files do not exist.

- [ ] **Step 3: Download official sources, convert four faces, and retain the license**

From the repository root, use a temporary directory and the official Google Fonts Sarabun source files:

```bash
font_tmp="$(mktemp -d)"
mkdir -p frontend/src/assets/fonts
for face in Regular Medium SemiBold Bold; do
  curl -fsSL "https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/Sarabun-${face}.ttf" -o "${font_tmp}/Sarabun-${face}.ttf"
  bun x ttf2woff2 "${font_tmp}/Sarabun-${face}.ttf" > "frontend/src/assets/fonts/Sarabun-${face}.woff2"
done
curl -fsSL "https://raw.githubusercontent.com/google/fonts/main/ofl/sarabun/OFL.txt" -o "frontend/src/assets/fonts/OFL.txt"
```

Do not commit the temporary TTF files. Confirm the outputs and license before removing the explicit temporary directory:

```bash
file frontend/src/assets/fonts/*.woff2
head -1 frontend/src/assets/fonts/OFL.txt
rm -r "${font_tmp}"
```

Expected: all four outputs identify as Web Open Font Format (Version 2), and the license begins with `Copyright` (the full file contains `SIL OPEN FONT LICENSE Version 1.1`).

- [ ] **Step 4: Declare the four local faces and Thai-only inherited font**

At the top of `frontend/src/index.css`, after the Tailwind imports, add:

```css
@font-face {
  font-family: "Sarabun";
  src: url("./assets/fonts/Sarabun-Regular.woff2") format("woff2");
  font-style: normal;
  font-weight: 400;
  font-display: swap;
}

@font-face {
  font-family: "Sarabun";
  src: url("./assets/fonts/Sarabun-Medium.woff2") format("woff2");
  font-style: normal;
  font-weight: 500;
  font-display: swap;
}

@font-face {
  font-family: "Sarabun";
  src: url("./assets/fonts/Sarabun-SemiBold.woff2") format("woff2");
  font-style: normal;
  font-weight: 600;
  font-display: swap;
}

@font-face {
  font-family: "Sarabun";
  src: url("./assets/fonts/Sarabun-Bold.woff2") format("woff2");
  font-style: normal;
  font-weight: 700;
  font-display: swap;
}
```

In the existing base layer, immediately after the `body` rule, add:

```css
  html:lang(th) body {
    font-family: "Sarabun", ui-sans-serif, system-ui, sans-serif;
  }

  button,
  input,
  optgroup,
  select,
  textarea {
    font-family: inherit;
  }
```

Do not override Tailwind's `font-mono` utility or add an English font selector.

- [ ] **Step 5: Run the font contract and production verification**

Run:

```bash
cd frontend
bun test tests/thai-font-assets.test.ts tests/i18n-document-language.test.ts tests/account-preferences.vitest.tsx
bun run lint
bun run build
```

Expected: all tests and lint pass; TypeScript and Vite build successfully, and Vite emits four hashed WOFF2 assets without a `fonts.googleapis.com` or `fonts.gstatic.com` runtime reference.

- [ ] **Step 6: Perform a browser smoke check**

Start the frontend with the repository's configured environment and inspect Account & Preferences:

```bash
cd frontend && bun run dev
```

Verify in browser developer tools:

- Thai selection sets `<html lang="th">` and computed `font-family` starts with `Sarabun` on headings, body text, buttons, and inputs.
- Regular, medium, semibold, and bold samples render without synthetic missing-weight warnings.
- English selection sets `<html lang="en">` and computed `font-family` no longer starts with `Sarabun`.
- The Network panel shows local WOFF2 requests only and no remote font requests.

- [ ] **Step 7: Record and commit the self-hosted typography**

Add beneath `## v0.3.9` → `### Added` in `CHANGELOG.md`:

```markdown
- Self-hosted Sarabun in WOFF2 weights 400, 500, 600, and 700 with its SIL Open Font License for the Thai interface.
```

Add beneath `## v0.3.9` → `### Changed`:

```markdown
- Applied Sarabun across Thai-language screens while preserving the existing system font stack for English and monospace data presentation.
```

Then run:

```bash
git add frontend/tests/thai-font-assets.test.ts frontend/src/assets/fonts frontend/src/index.css CHANGELOG.md
git diff --cached --check
git commit -m "feat: self-host Thai Sarabun typography"
```

Expected: one commit containing only the font contract, licensed assets, stylesheet change, and changelog entries.

---

## Final Verification

From `frontend/`, run the complete frontend gate:

```bash
bun test
bun run lint
bun run build
```

Expected: the full Vitest suite, ESLint, TypeScript build, and Vite production build all pass. Review `git status --short` and confirm only the user's pre-existing unrelated untracked files remain.
