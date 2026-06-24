#!/usr/bin/env python3
"""Generate MathShield's localized unit index from a pinned CLDR release."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import sys
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path


CLDR_VERSION = "48.2.0"
CLDR_URL = (
    "https://github.com/unicode-org/cldr-json/releases/download/"
    f"{CLDR_VERSION}/cldr-{CLDR_VERSION}-json-full.zip"
)
CLDR_SHA256 = "084d98b3f01454e7a2af9dbf5fb4adc7205f42a0808a9fd3ecf74ecfb116339a"
QUDT_VERSION = "3.3.0"
QUDT_BASE_URI = "http://qudt.org/vocab/unit/"
CONTROL_CHARS = re.compile(r"[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]")
PLACEHOLDER = re.compile(r"\{0\}")

PREFIXES = (
    ("quecto", "q", "q", -30),
    ("ronto", "r", "r", -27),
    ("yocto", "y", "y", -24),
    ("zepto", "z", "z", -21),
    ("atto", "a", "a", -18),
    ("femto", "f", "f", -15),
    ("pico", "p", "p", -12),
    ("nano", "n", "n", -9),
    ("micro", "u", "\\mu", -6),
    ("milli", "m", "m", -3),
    ("centi", "c", "c", -2),
    ("deci", "d", "d", -1),
    ("deca", "da", "da", 1),
    ("hecto", "h", "h", 2),
    ("kilo", "k", "k", 3),
    ("mega", "M", "M", 6),
    ("giga", "G", "G", 9),
    ("tera", "T", "T", 12),
    ("peta", "P", "P", 15),
    ("exa", "E", "E", 18),
    ("zetta", "Z", "Z", 21),
    ("yotta", "Y", "Y", 24),
    ("ronna", "R", "R", 27),
    ("quetta", "Q", "Q", 30),
)


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--definitions",
        type=Path,
        default=root / "data" / "unit-definitions.json",
    )
    parser.add_argument("--output", type=Path, default=root / "units-db.json")
    parser.add_argument(
        "--archive",
        type=Path,
        help="Use an existing cldr-json release ZIP instead of downloading it.",
    )
    return parser.parse_args()


def read_archive(path: Path | None) -> zipfile.ZipFile:
    if path:
        payload = path.read_bytes()
    else:
        request = urllib.request.Request(CLDR_URL, headers={"User-Agent": "MathShield-builder"})
        print(f"Downloading CLDR {CLDR_VERSION}...", file=sys.stderr)
        with urllib.request.urlopen(request) as response:
            payload = response.read()

    actual_digest = hashlib.sha256(payload).hexdigest()
    if actual_digest != CLDR_SHA256:
        raise ValueError(
            f"CLDR archive checksum mismatch: expected {CLDR_SHA256}, got {actual_digest}"
        )
    return zipfile.ZipFile(io.BytesIO(payload))


def locale_from_path(name: str) -> str | None:
    marker = "cldr-units-full/main/"
    if marker not in name or not name.endswith("/units.json"):
        return None
    locale = name.split(marker, 1)[1].split("/", 1)[0]
    parts = locale.split("-")
    if len(parts) == 1 or (len(parts) == 2 and len(parts[1]) == 4):
        return locale
    return None


def clean_alias(value: str) -> str:
    value = PLACEHOLDER.sub("", value)
    value = CONTROL_CHARS.sub("", value)
    value = unicodedata.normalize("NFC", value)
    return " ".join(value.replace("\u00a0", " ").split()).strip(" ,;:")


def alias_key(value: str, fold_case: bool) -> str:
    normalized = clean_alias(value)
    return normalized.lower() if fold_case else normalized


def aliases_from_unit(unit: dict) -> set[str]:
    aliases = set()
    if unit.get("displayName"):
        aliases.add(clean_alias(unit["displayName"]))
    for key, value in unit.items():
        if key.startswith("unitPattern-count-") and isinstance(value, str):
            aliases.add(clean_alias(value))
    return {
        alias
        for alias in aliases
        if alias
        and not alias.startswith(("/", "*", "·"))
        and not any(char.isdigit() for char in alias)
    }


def prefixed_definition(
    base: dict, prefix_name: str, ucum_prefix: str, symbol_prefix: str
) -> dict:
    category, unit_name = base["cldrId"].split("-", 1)
    symbol = f"{symbol_prefix}{base['symbol']}"
    return {
        "cldrId": f"{category}-{prefix_name}{unit_name}",
        "ucumCode": f"{ucum_prefix}{base['ucumCode']}",
        "qudtId": None,
        "quantityKind": base["quantityKind"],
        "symbol": symbol,
        "derivedFrom": f"ucum:{base['ucumCode']}",
    }


def build_unit_catalog(definitions: list[dict]) -> list[dict]:
    catalog = []
    seen = set()
    prefixed = [
        prefixed_definition(definition, *prefix[:3])
        for definition in definitions
        if definition.get("prefixable")
        for prefix in PREFIXES
    ]
    for candidate in [*definitions, *prefixed]:
        unit_id = f"ucum:{candidate['ucumCode']}"
        if unit_id in seen:
            continue
        seen.add(unit_id)
        record = {
            "id": unit_id,
            "ucumCode": candidate["ucumCode"],
            "cldrId": candidate["cldrId"],
            "qudtUri": (
                f"{QUDT_BASE_URI}{candidate['qudtId']}" if candidate.get("qudtId") else None
            ),
            "quantityKind": candidate["quantityKind"],
            "symbol": candidate["symbol"],
        }
        if candidate.get("latexSymbol"):
            record["latexSymbol"] = candidate["latexSymbol"]
        if candidate.get("derivedFrom"):
            record["derivedFrom"] = candidate["derivedFrom"]
        catalog.append(record)
    return catalog


def generate(definitions_path: Path, output_path: Path, archive_path: Path | None) -> None:
    definitions = json.loads(definitions_path.read_text(encoding="utf-8"))["units"]
    catalog = build_unit_catalog(definitions)
    catalog_by_cldr = {unit["cldrId"]: unit for unit in catalog}
    aliases: dict[str, dict[str, dict[str, dict[str, list]]]] = defaultdict(
        lambda: {"exact": defaultdict(dict), "folded": defaultdict(dict)}
    )
    widths = {"long": (0.98, "name"), "short": (0.95, "abbreviation"), "narrow": (0.90, "symbol")}

    def add_alias(locale, index_name, key, canonical, confidence, alias_type, surface):
        existing = aliases[locale][index_name][key].get(canonical["id"])
        entry = [canonical["id"], confidence, alias_type, surface]
        if not existing or confidence > existing[1]:
            aliases[locale][index_name][key][canonical["id"]] = entry

    with read_archive(archive_path) as archive:
        locale_files = sorted(
            (locale_from_path(name), name) for name in archive.namelist() if locale_from_path(name)
        )
        for locale, name in locale_files:
            payload = json.loads(archive.read(name))
            units = payload["main"][locale]["units"]
            for width, (confidence, alias_type) in widths.items():
                width_data = units.get(width, {})
                for cldr_id, canonical in catalog_by_cldr.items():
                    localized = width_data.get(cldr_id)
                    if not localized:
                        continue
                    for surface in sorted(aliases_from_unit(localized)):
                        if alias_type == "name" and re.fullmatch(r"[A-Za-z]", surface):
                            continue
                        index_name = "folded" if alias_type == "name" else "exact"
                        key = alias_key(surface, fold_case=index_name == "folded")
                        add_alias(locale, index_name, key, canonical, confidence, alias_type, surface)

                # CLDR defines most SI-prefixed units compositionally. Materialize
                # those localized patterns so aliases such as Russian мВ and ммоль
                # are available without maintaining language-specific exceptions.
                for base in (item for item in definitions if item.get("prefixable")):
                    localized_base = width_data.get(base["cldrId"])
                    if not localized_base:
                        continue
                    base_surfaces = sorted(aliases_from_unit(localized_base))
                    category, unit_name = base["cldrId"].split("-", 1)
                    for prefix_name, _ucum, _symbol, exponent in PREFIXES:
                        pattern = width_data.get(f"10p{exponent}", {}).get("unitPrefixPattern")
                        canonical = catalog_by_cldr.get(f"{category}-{prefix_name}{unit_name}")
                        if not pattern or not canonical:
                            continue
                        for base_surface in base_surfaces:
                            surface = clean_alias(pattern.replace("{0}", base_surface))
                            if not surface:
                                continue
                            index_name = "folded" if alias_type == "name" else "exact"
                            key = alias_key(surface, fold_case=index_name == "folded")
                            add_alias(
                                locale,
                                index_name,
                                key,
                                canonical,
                                confidence,
                                alias_type,
                                surface,
                            )

    compact_aliases = {
        locale: {
            index_name: {
                key: sorted(candidates.values(), key=lambda candidate: (-candidate[1], candidate[0]))
                for key, candidates in sorted(index.items())
            }
            for index_name, index in locale_aliases.items()
        }
        for locale, locale_aliases in sorted(aliases.items())
        if locale_aliases["exact"] or locale_aliases["folded"]
    }
    def unique_global_index(index_name: str) -> dict[str, list[list]]:
        global_candidates: dict[str, dict[str, list]] = defaultdict(dict)
        for locale_aliases in compact_aliases.values():
            for key, candidates in locale_aliases[index_name].items():
                for candidate in candidates:
                    existing = global_candidates[key].get(candidate[0])
                    if not existing or candidate[1] > existing[1]:
                        global_candidates[key][candidate[0]] = candidate
        return {
            key: list(candidates.values())
            for key, candidates in sorted(global_candidates.items())
            if len(candidates) == 1
        }

    global_exact = unique_global_index("exact")
    global_folded = unique_global_index("folded")
    base_ids = {f"ucum:{definition['ucumCode']}" for definition in definitions}
    used_ids = base_ids | {
        candidate[0]
        for locale_aliases in compact_aliases.values()
        for index in locale_aliases.values()
        for candidates in index.values()
        for candidate in candidates
    }
    output = {
        "schemaVersion": 2,
        "dataVersion": f"cldr-{CLDR_VERSION}_qudt-{QUDT_VERSION}",
        "sources": {
            "cldr": {"version": CLDR_VERSION, "url": CLDR_URL, "license": "Unicode-3.0"},
            "ucum": {"version": "2.2", "role": "canonical unit codes"},
            "qudt": {"version": QUDT_VERSION, "license": "CC-BY-4.0"},
        },
        "normalization": "NFC; locale-aware matching uses case-folded lookup keys only",
        "units": sorted(
            (unit for unit in catalog if unit["id"] in used_ids),
            key=lambda unit: unit["id"],
        ),
        "globalExact": global_exact,
        "globalFolded": global_folded,
        "locales": compact_aliases,
    }
    output_path.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    print(
        f"Wrote {len(output['units'])} units and {len(output['locales'])} locales to {output_path}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    args = parse_args()
    generate(args.definitions, args.output, args.archive)
