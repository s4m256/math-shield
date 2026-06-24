# MathShield

MathShield is a Chrome Manifest V3 extension that protects and repairs mathematical
expressions when webpages are translated.

## What it does

- Protects MathJax, KaTeX, MathML, and LaTeX source nodes from page translation.
- Recognizes localized unit names and symbols from 383 CLDR locales.
- Maps localized aliases to canonical UCUM codes and QUDT identifiers.
- Handles simple and compound units, SI prefixes, exponents, and localized digits.
- Preserves unknown macros, ambiguous aliases, and unsupported expressions unchanged.
- Re-renders supported math engines after a safe source update.

MathShield does not send page content to a translation service. Natural-language text
inside formulas is preserved in v2; only recognized unit spans are normalized. An
authenticated translation provider can be added later behind a backend, without making
free translation authoritative for mathematical tokens.

## Architecture

The runtime follows a conservative pipeline:

1. Collect LaTeX sources and delimited text without entering rendered math.
2. Parse macros and balanced groups while preserving source offsets.
3. Resolve units against locale-specific exact and folded indexes.
4. Use global fallbacks only when an alias maps to one canonical unit in every locale.
5. Rewrite local spans and leave collisions, unknown macros, and mixed tokens untouched.
6. Ask MathJax or KaTeX to render only changed roots.

`units-db.json` is generated from CLDR. `data/unit-definitions.json` contains the small
semantic reconciliation layer between CLDR unit IDs, UCUM codes, and QUDT URIs. It does
not contain per-language translations.

## Generate the database

Python 3.10 or newer is required. The generator downloads the pinned CLDR release and
produces deterministic JSON:

```powershell
python scripts/generate_units_db.py
python scripts/validate_units_db.py
```

CLDR, UCUM, and QUDT versions are recorded inside the generated artifact. Review
`THIRD_PARTY_NOTICES.md` before changing or redistributing source data.

## Test

Run the browser corpus with Chrome, Chromium, or Edge:

```powershell
python tests/run.py
```

The corpus covers Latin, Cyrillic, Arabic, Hebrew, Devanagari, and CJK aliases,
Arabic-Indic digits, case-sensitive symbols, localized derived units, unknown macros,
and expressions that must remain byte-identical.

`tests/manual-dynamic.html` remains available for visual MathJax and KaTeX testing.

### Live E2E regression loop

The Playwright suite loads the real unpacked MV3 extension in Chromium and checks the
three configured `pho.rs` pages against a clean baseline. By default, each page runs
three times in a fresh browser profile; the input is capped at five iterations.

```powershell
npm run test:e2e
npm run test:e2e:loop
$env:MATHSHIELD_ITERATIONS=5; npm run test:e2e:loop
$env:MATHSHIELD_HEADED=1; npm run test:e2e:loop
```

`test:e2e` runs the parametrized suite directly and `test:e2e:loop` validates and
clamps the iteration count first. A translated proxy URL can be supplied without
automating Chrome's native translation UI:

```powershell
$env:MATHSHIELD_TRANSLATED_URL_TEMPLATE='https://example.test/?url={encodedUrl}&lang={target}'
$env:MATHSHIELD_TARGET_LANGUAGE='pt'
npm run test:e2e:loop
```

Results are written to `artifacts/e2e/<page-id>/`. Each baseline and iteration contains
full-page screenshots and JSON inventories with source, rendered HTML, bounding boxes,
unit changes, and runtime diagnostics. Failing iterations retain trace, video, and
formula crops; `playwright-report/` contains the HTML report. HTTP blocks, CAPTCHA,
external timeouts, and unavailable pages are reported as inconclusive rather than
passing silently.

## Install locally

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project directory.

## Privacy and production constraints

- Page content remains local to the browser.
- No API key or secret is bundled with the extension.
- Executable logic is packaged with the extension; no remote code is loaded.
- The only runtime data fetch reads the packaged `units-db.json` resource.
- Ambiguity favors preservation: an unchanged formula is better than an incorrect one.

## Current limitations

- Natural-language prose inside formulas is not translated by MathShield v2.
- The parser intentionally supports a conservative LaTeX subset rather than every
  custom macro package.
- Canonical coverage is limited to the STEM units listed in
  `data/unit-definitions.json`; language coverage for those units is generated.
- Remote signed vocabulary updates and an optional authenticated backend are future
  extensions, not publication requirements for this version.
