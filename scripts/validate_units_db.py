#!/usr/bin/env python3
"""Validate the generated MathShield unit database."""

from __future__ import annotations

import argparse
import json
import unicodedata
from pathlib import Path


REQUIRED_LOCALES = {"ar", "el", "he", "hi", "ja", "pt", "ru", "zh"}


def parse_args() -> argparse.Namespace:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("database", nargs="?", type=Path, default=root / "units-db.json")
    return parser.parse_args()


def validate(path: Path) -> None:
    data = json.loads(path.read_text(encoding="utf-8"))
    errors = []

    if data.get("schemaVersion") != 2:
        errors.append("schemaVersion must be 2")
    if not data.get("dataVersion"):
        errors.append("dataVersion is required")
    sources = data.get("sources", {})
    if sources.get("cldr", {}).get("version") != "48.2.0":
        errors.append("CLDR source version must be 48.2.0")
    if sources.get("ucum", {}).get("version") != "2.2":
        errors.append("UCUM source version must be 2.2")
    if sources.get("qudt", {}).get("version") != "3.3.0":
        errors.append("QUDT source version must be 3.3.0")

    units = data.get("units", [])
    unit_ids = {unit.get("id") for unit in units}
    if None in unit_ids or len(unit_ids) != len(units):
        errors.append("unit ids must be present and unique")
    kilogram = next((unit for unit in units if unit.get("id") == "ucum:kg"), None)
    if not kilogram or kilogram.get("qudtUri") != "http://qudt.org/vocab/unit/KiloGM":
        errors.append("explicit kilogram semantics must override generated prefix metadata")
    for unit in units:
        if "\\" in str(unit.get("ucumCode", "")):
            errors.append(f"{unit.get('id')}: UCUM codes must not contain LaTeX commands")
        if not unit.get("derivedFrom") and not str(unit.get("qudtUri", "")).startswith(
            "http://qudt.org/vocab/unit/"
        ):
            errors.append(f"{unit.get('id')}: explicit units require a QUDT URI")

    locales = data.get("locales", {})
    missing_locales = REQUIRED_LOCALES - locales.keys()
    if missing_locales:
        errors.append(f"missing required locales: {sorted(missing_locales)}")

    alias_count = 0
    collision_count = 0
    for locale, locale_data in locales.items():
        if set(locale_data) != {"exact", "folded"}:
            errors.append(f"{locale}: expected exact and folded indexes")
            continue
        for index_name, index in locale_data.items():
            for key, candidates in index.items():
                alias_count += 1
                collision_count += len(candidates) > 1
                if unicodedata.normalize("NFC", key) != key:
                    errors.append(f"{locale}/{index_name}: key is not NFC: {key!r}")
                if key.startswith(("/", "*", "·")):
                    errors.append(f"{locale}/{index_name}: invalid leading separator: {key!r}")
                for candidate in candidates:
                    if len(candidate) != 4:
                        errors.append(f"{locale}/{key}: invalid candidate shape")
                        continue
                    unit_id, confidence, alias_type, surface = candidate
                    if unit_id not in unit_ids:
                        errors.append(f"{locale}/{key}: unknown unit {unit_id}")
                    if not 0 <= confidence <= 1:
                        errors.append(f"{locale}/{key}: invalid confidence {confidence}")
                    if alias_type not in {"name", "abbreviation", "symbol"}:
                        errors.append(f"{locale}/{key}: invalid alias type {alias_type}")
                    if unicodedata.normalize("NFC", surface) != surface:
                        errors.append(f"{locale}/{key}: surface is not NFC")

    for index_name in ("globalExact", "globalFolded"):
        for key, candidates in data.get(index_name, {}).items():
            if len(candidates) != 1:
                errors.append(f"{index_name}/{key}: global aliases must be unambiguous")
            if candidates and candidates[0][0] not in unit_ids:
                errors.append(f"{index_name}/{key}: unknown unit {candidates[0][0]}")

    if errors:
        raise SystemExit("Database validation failed:\n- " + "\n- ".join(errors[:100]))

    print(
        f"Database OK: {len(units)} units, {len(locales)} locales, "
        f"{alias_count} aliases, {collision_count} preserved collisions"
    )


if __name__ == "__main__":
    validate(parse_args().database)
