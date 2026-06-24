(() => {
  "use strict";

  const MATH_SELECTORS = [
    ".MathJax",
    ".MathJax_Preview",
    ".MathJax_Display",
    'script[type*="math/tex"]',
    "mjx-container",
    ".katex",
    ".katex-display",
    "math",
    'annotation[encoding="application/x-tex"]',
  ].join(",");

  const LATEX_SOURCE_SELECTORS = [
    'script[type*="math/tex"]',
    'annotation[encoding="application/x-tex"]',
  ].join(",");

  const TRANSLATABLE_TEXT_MACROS = new Set([
    "text",
    "mbox",
    "textbf",
    "textit",
    "textrm",
    "textsf",
    "texttt",
  ]);

  const UNIT_MACROS = new Set(["mathrm", "si", "unit", "qty", "SI"]);
  const NEVER_TRANSLATE_MACROS = new Set([
    "frac",
    "sqrt",
    "sum",
    "int",
    "lim",
    "sin",
    "cos",
    "tan",
    "log",
    "ln",
    "operatorname",
    "vec",
    "hat",
    "bar",
    "overline",
  ]);

  const DEFAULT_DEBOUNCE_MS = 120;

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isElement(node) {
    return node?.nodeType === Node.ELEMENT_NODE;
  }

  function getDocumentRoot() {
    return document.body || document.documentElement;
  }

  function debounce(callback, delay) {
    let timer = 0;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => callback(...args), delay);
    };
  }

  const domShield = {
    protectNode(node, protectedNodes) {
      if (!isElement(node) || protectedNodes.has(node)) return;
      // Touching a MathJax v2 frame during construction can leave it hidden.
      if (node.classList.contains("MJXc-processing")) return;

      node.classList.add("notranslate");
      node.setAttribute("translate", "no");
      node.setAttribute("data-mathshield-protected", "true");

      if (node.classList.contains("MathJax") || node.tagName === "MJX-CONTAINER") {
        node.style.marginLeft ||= "0.3em";
        node.style.marginRight ||= "0.3em";
      }

      protectedNodes.add(node);
    },

    protectAll(root, protectedNodes) {
      if (!root) return;

      if (isElement(root) && root.matches(MATH_SELECTORS)) {
        this.protectNode(root, protectedNodes);
      }

      root.querySelectorAll?.(MATH_SELECTORS).forEach((node) => {
        this.protectNode(node, protectedNodes);
      });
    },
  };

  const latexSourceCollector = {
    collect(root) {
      const sources = [];
      const addSource = (node) => {
        if (!node || sources.some((source) => source.node === node)) return;
        sources.push({
          node,
          root: node.closest(".MathJax_Display, mjx-container, .katex-display") || node.parentElement,
          getLatex: () => node.textContent || "",
          setLatex: (latex) => {
            node.textContent = latex;
          },
          transform: (latex, options) => latexTransformer.transform(latex, options),
        });
      };

      if (isElement(root) && root.matches?.(LATEX_SOURCE_SELECTORS)) {
        addSource(root);
      }

      root.querySelectorAll?.(LATEX_SOURCE_SELECTORS).forEach(addSource);
      this.collectDelimitedTextNodes(root, sources);
      return sources;
    },

    collectDelimitedTextNodes(root, sources) {
      const walkerRoot = root.nodeType === Node.TEXT_NODE ? root.parentElement : root;
      if (!walkerRoot?.ownerDocument) return;

      const walker = document.createTreeWalker(walkerRoot, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (parent.closest(MATH_SELECTORS) || parent.closest("script, style, textarea")) {
            return NodeFilter.FILTER_REJECT;
          }
          return this.findDelimitedSegments(node.textContent || "").length
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });

      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!this.findDelimitedSegments(node.textContent || "").length) continue;

        sources.push({
          node,
          root: node.parentElement,
          getLatex: () => node.textContent || "",
          setLatex: (text) => {
            node.textContent = text;
          },
          transform: (text, options) => latexTransformer.transformDelimitedText(text, options),
        });
      }
    },

    findDelimitedSegments(text) {
      const segments = [];
      let index = 0;

      while (index < text.length) {
        const opener = this.readOpener(text, index);
        if (!opener) {
          index++;
          continue;
        }

        const closeIndex = this.findClosingDelimiter(text, opener.contentStart, opener.right);
        if (closeIndex < 0) {
          index += opener.left.length;
          continue;
        }

        const latex = text.slice(opener.contentStart, closeIndex);
        if (opener.left !== "$" || this.looksLikeMath(latex)) {
          segments.push({
            start: index,
            end: closeIndex + opener.right.length,
            latexStart: opener.contentStart,
            latexEnd: closeIndex,
            left: opener.left,
            right: opener.right,
          });
        }

        index = closeIndex + opener.right.length;
      }

      return segments;
    },

    readOpener(text, index) {
      if (text.startsWith("\\(", index)) {
        return { left: "\\(", right: "\\)", contentStart: index + 2 };
      }
      if (text.startsWith("\\[", index)) {
        return { left: "\\[", right: "\\]", contentStart: index + 2 };
      }
      if (text.startsWith("$$", index) && !this.isEscaped(text, index)) {
        return { left: "$$", right: "$$", contentStart: index + 2 };
      }
      if (text[index] === "$" && !this.isEscaped(text, index)) {
        return { left: "$", right: "$", contentStart: index + 1 };
      }
      return null;
    },

    findClosingDelimiter(text, start, delimiter) {
      for (let index = start; index < text.length; index++) {
        if (text.startsWith(delimiter, index) && !this.isEscaped(text, index)) {
          return index;
        }
      }
      return -1;
    },

    isEscaped(text, index) {
      let backslashes = 0;
      for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
        backslashes++;
      }
      return backslashes % 2 === 1;
    },

    looksLikeMath(latex) {
      return /\\[A-Za-z]+|[_^{}=+\-*/]|\p{Nd}\s*[\p{L}\\]/u.test(latex);
    },
  };

  const unitNormalizer = {
    // This compact set is canonical notation, not a language-specific unit list.
    canonicalSymbols: new Set([
      "m",
      "s",
      "g",
      "kg",
      "A",
      "K",
      "mol",
      "cd",
      "N",
      "J",
      "W",
      "Pa",
      "C",
      "V",
      "F",
      "Ohm",
      "Omega",
      "Hz",
      "H",
      "T",
      "Wb",
      "S",
      "lm",
      "lx",
      "Bq",
      "Gy",
      "Sv",
      "kat",
      "rad",
      "sr",
      "L",
      "l",
      "eV",
      "bar",
      "atm",
      "min",
      "h",
      "d",
    ]),

    prefixSymbols: [
      "\\mu",
      "mu",
      "da",
      "Y",
      "Q",
      "R",
      "Z",
      "E",
      "P",
      "T",
      "G",
      "M",
      "k",
      "h",
      "d",
      "c",
      "m",
      "u",
      "n",
      "p",
      "f",
      "a",
      "z",
      "y",
      "r",
      "q",
    ],

    unitById: new Map(),
    unitBySymbol: new Map(),
    localeIndexes: {},
    globalExactIndex: {},
    globalFoldedIndex: {},
    activeLocaleKeys: [],
    loadPromise: null,

    async loadGeneratedDatabase() {
      if (this.loadPromise) return this.loadPromise;

      this.loadPromise = (async () => {
        try {
          const response = await fetch(chrome.runtime.getURL("units-db.json"));
          if (!response.ok) return;

          const data = await response.json();
          if (data.schemaVersion !== 2 || !Array.isArray(data.units)) return;

          for (const unit of data.units) {
            if (!unit?.id || !unit?.symbol) continue;
            this.unitById.set(unit.id, unit);
            this.unitBySymbol.set(unit.symbol, unit);
            this.canonicalSymbols.add(unit.symbol);
          }

          this.localeIndexes = data.locales || {};
          this.globalExactIndex = data.globalExact || {};
          this.globalFoldedIndex = data.globalFolded || {};
          this.activeLocaleKeys = this.resolveLocaleKeys(this.sourceLocales());

          const version = data.dataVersion;
          if (version && chrome.storage?.local) {
            chrome.storage.local.set({ mathshieldDataVersion: version }).catch(() => {});
          }
        } catch {
          // Canonical symbols still work if the packaged database cannot be read.
        }
      })();

      return this.loadPromise;
    },

    normalizeUnitText(text, options = {}) {
      const trimmed = text.trim();
      if (!trimmed) return null;

      const alias = this.aliasToSymbol(trimmed, { allowWordAliases: true });
      if (alias) return this.formatUnitSymbol(alias, options.output || "latex");

      return this.normalizeSymbolExpression(trimmed, options);
    },

    hasLocalizedCharacters(text) {
      return /[^\x00-\x7f]/.test(text);
    },

    normalizeUnitsInHumanText(text) {
      let next = text;

      const unitToken = String.raw`(?:\\mu|[\p{L}\\]+)(?:\s*(?:\^|[\u00b2\u00b3])\s*[+-]?\d*)?`;
      const unitExpression = String.raw`${unitToken}(?:\s*(?:\/|\*|\.|\u00b7)\s*${unitToken})*`;
      const unitAfterNumber = new RegExp(
        String.raw`(\p{Nd}+(?:[.,\u066b\u066c\u00a0\u202f]\p{Nd}+)*\s+)(` +
          unitExpression +
          ")",
        "gu"
      );

      next = next.replace(unitAfterNumber, (match, prefix, unit, offset, source) => {
        if (/^\s+\p{L}/u.test(source.slice(offset + match.length))) return match;
        const normalized = this.normalizeSymbolExpression(unit, {
          output: "text",
          allowWordAliases: true,
        });
        return normalized ? `${prefix}${normalized}` : match;
      });

      next = next.replace(
        /(?<![\p{L}\\_])(?:\\mu|[\p{L}\\]+)(?:\s*(?:\/|\*|\.|\u00b7)\s*(?:\\mu|[\p{L}\\]+)(?:\s*(?:\^|[\u00b2\u00b3])\s*[+-]?\d*)?)*/gu,
        (match) => {
          const normalized = this.normalizeSymbolExpression(match, {
            output: "text",
            allowWordAliases: false,
          });
          return normalized || match;
        }
      );

      return next;
    },

    normalizeSymbolExpression(value, options = {}) {
      const output = options.output || "latex";
      const normalized = value
        .normalize("NFC")
        .trim()
        .replace(/\u03a9/g, "Omega")
        .replace(/\u00b5/g, "mu");

      if (!normalized) return null;

      const wholeUnit = this.aliasToSymbol(normalized, {
        allowWordAliases: options.allowWordAliases !== false,
      });
      if (wholeUnit) return this.formatUnitSymbol(wholeUnit, output);

      const tokens = normalized.split(/(\s*(?:\/|\*|\.|\u00b7|\\cdot)\s*)/u);
      if (tokens.length % 2 === 0) return null;

      const parts = [];
      for (let index = 0; index < tokens.length; index += 2) {
        const factor = tokens[index].trim();
        const match = factor.match(
          /^(.*?)(?:\s*\^(?:\{([+-]?\d+)\}|([+-]?\d+))|([\u00b2\u00b3]))?$/u
        );
        if (!match || !match[1].trim()) return null;

        const symbol = this.canonicalizeSymbol(match[1].trim(), options);
        if (!symbol) return null;

        const rawSeparator = index === 0 ? "" : tokens[index - 1].trim();
        const separator =
          rawSeparator === "/" ? "/" : output === "text" ? " " : "\\,";
        parts.push({
          separator,
          symbol,
          exponent: match[2] || match[3] || this.unicodeExponent(match[4]),
        });
      }

      return parts
        .map((part, i) => {
          const prefix = i === 0 ? "" : part.separator;
          const unit = this.formatUnitSymbol(part.symbol, output);
          const exponent =
            output === "latex" && part.exponent
              ? `^{${part.exponent}}`
              : part.exponent
                ? `^${part.exponent}`
                : "";
          return `${prefix}${unit}${exponent}`;
        })
        .join("");
    },

    canonicalizeSymbol(raw, options = {}) {
      const alias = this.aliasToSymbol(raw, {
        allowWordAliases: options.allowWordAliases !== false,
      });
      if (alias) return alias;

      if (raw === "Omega") return "\\Omega";
      if (raw === "mu") return "\\mu";
      if (this.canonicalSymbols.has(raw)) return raw;

      const rawKey = this.normalizeAliasKey(raw, false);
      const prefixMatch = this.prefixSymbols.find(
        (prefix) => rawKey.startsWith(prefix) && rawKey.length > prefix.length
      );

      if (!prefixMatch) return null;
      const baseKey = rawKey.slice(prefixMatch.length);
      const base = this.unitBySymbol.get(baseKey)?.symbol;
      if (!base && !this.canonicalSymbols.has(baseKey)) return null;
      return `${prefixMatch}${base || baseKey}`;
    },

    unicodeExponent(value) {
      if (value === "\u00b2") return "2";
      if (value === "\u00b3") return "3";
      return "";
    },

    aliasToSymbol(value, options = {}) {
      const normalized = this.normalizeAliasKey(value, false);
      const canonical = this.unitBySymbol.get(normalized);
      if (canonical) return canonical.symbol;

      const candidates = new Map();
      const addCandidates = (items, minimumConfidence) => {
        for (const item of items || []) {
          const [unitId, confidence] = item;
          if (confidence < minimumConfidence || !this.unitById.has(unitId)) continue;
          const previous = candidates.get(unitId);
          if (!previous || confidence > previous) candidates.set(unitId, confidence);
        }
      };

      const localeKeys = [...this.activeLocaleKeys];
      if (
        /\p{Script=Cyrillic}/u.test(value) &&
        this.localeIndexes.ru &&
        !localeKeys.includes("ru")
      ) {
        localeKeys.push("ru");
      }

      for (const locale of localeKeys) {
        addCandidates(this.localeIndexes[locale]?.exact?.[normalized], 0.9);
      }
      addCandidates(this.globalExactIndex[normalized], 0.95);

      if (options.allowWordAliases !== false) {
        const folded = this.normalizeAliasKey(value, true);
        for (const locale of localeKeys) {
          addCandidates(this.localeIndexes[locale]?.folded?.[folded], 0.95);
        }
        addCandidates(this.globalFoldedIndex[folded], 0.98);
      }

      if (candidates.size !== 1) return null;
      const [unitId] = candidates.keys();
      return this.unitById.get(unitId)?.symbol || null;
    },

    normalizeAliasKey(value, foldCase) {
      const normalized = String(value)
        .normalize("NFC")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return foldCase ? normalized.toLocaleLowerCase() : normalized;
    },

    sourceLocales() {
      const candidates = [
        document.documentElement?.lang,
        ...Array.from(document.querySelectorAll("[lang]"))
          .slice(0, 10)
          .map((node) => node.getAttribute("lang")),
        ...(navigator.languages || []),
        navigator.language,
      ];

      return [...new Set(candidates.filter(Boolean).map((locale) => locale.trim()))];
    },

    resolveLocaleKeys(locales) {
      const keys = [];
      for (const candidate of locales) {
        try {
          const locale = new Intl.Locale(candidate.replace(/_/g, "-"));
          const variants = [
            locale.baseName,
            locale.script ? `${locale.language}-${locale.script}` : null,
            locale.language,
          ];
          for (const variant of variants) {
            if (variant && this.localeIndexes[variant] && !keys.includes(variant)) {
              keys.push(variant);
            }
          }
        } catch {
          // Ignore invalid lang attributes supplied by the page.
        }
      }
      return keys;
    },

    refreshActiveLocales() {
      this.activeLocaleKeys = this.resolveLocaleKeys(this.sourceLocales());
    },

    formatUnitSymbol(symbol, output) {
      if (output === "text") return this.textUnitSymbol(symbol);
      const latexSymbol = this.unitBySymbol.get(symbol)?.latexSymbol;
      if (latexSymbol) return latexSymbol;
      if (symbol === "\\Omega") return "\\Omega";

      const micro = symbol.match(/^\\mu(.+)$/);
      if (micro) return `\\mu\\mathrm{${micro[1]}}`;

      return symbol.startsWith("\\") ? symbol : `\\mathrm{${symbol}}`;
    },

    textUnitSymbol(symbol) {
      if (symbol === "\\Omega") return "\u03a9";
      if (symbol.startsWith("\\mu")) return `u${symbol.slice(3)}`;
      return symbol.replace(/\\/g, "");
    },
  };

  const latexTransformer = {
    async transformDelimitedText(text, options) {
      const segments = latexSourceCollector.findDelimitedSegments(text);
      if (!segments.length) return text;

      let next = "";
      let cursor = 0;
      for (const segment of segments) {
        next += text.slice(cursor, segment.latexStart);
        const latex = text.slice(segment.latexStart, segment.latexEnd);
        next += await this.transform(latex, options);
        cursor = segment.latexEnd;
      }
      next += text.slice(cursor);
      return next;
    },

    async transform(latex, options = {}) {
      await unitNormalizer.loadGeneratedDatabase();
      if (options.sourceLocales?.length) {
        unitNormalizer.activeLocaleKeys = unitNormalizer.resolveLocaleKeys(options.sourceLocales);
      } else {
        unitNormalizer.refreshActiveLocales();
      }

      const replacements = [];
      this.walkLatex(latex, 0, latex.length, (macro) => {
        if (NEVER_TRANSLATE_MACROS.has(macro.name)) return;

        if (macro.name === "mathrm") {
          if (!unitNormalizer.hasLocalizedCharacters(macro.argument)) return false;
          const normalized = unitNormalizer.normalizeUnitText(macro.argument);
          if (normalized) {
            replacements.push({
              start: macro.start,
              end: macro.end,
              value: normalized,
            });
          }
          return false;
        }

        if (UNIT_MACROS.has(macro.name)) {
          return false;
        }

        if (!TRANSLATABLE_TEXT_MACROS.has(macro.name)) return false;
        const wholeUnit = unitNormalizer.hasLocalizedCharacters(macro.argument)
          ? unitNormalizer.normalizeUnitText(macro.argument)
          : null;
        if (wholeUnit) {
          replacements.push({
            start: macro.start,
            end: macro.end,
            value: wholeUnit,
          });
          return false;
        }

        replacements.push({
          start: macro.argumentStart,
          end: macro.argumentEnd,
          value: unitNormalizer.normalizeUnitsInHumanText(macro.argument),
        });
        return false;
      });

      return this.normalizeBareUnits(this.applyReplacements(latex, replacements));
    },

    walkLatex(latex, start, end, onMacro) {
      let index = start;

      while (index < end) {
        if (latex[index] !== "\\") {
          index++;
          continue;
        }

        const command = this.readCommand(latex, index);
        if (!command) {
          index++;
          continue;
        }

        const argument = this.readFirstBracedArgument(latex, command.end);
        if (argument) {
          const shouldRecurse = onMacro({
            name: command.name,
            start: index,
            end: argument.end + 1,
            argument: latex.slice(argument.start + 1, argument.end),
            argumentStart: argument.start + 1,
            argumentEnd: argument.end,
          });

          if (shouldRecurse !== false) {
            this.walkLatex(latex, argument.start + 1, argument.end, onMacro);
          }
          index = argument.end + 1;
          continue;
        }

        index = command.end;
      }
    },

    readCommand(latex, index) {
      if (latex[index] !== "\\") return null;

      const rest = latex.slice(index + 1);
      const match = rest.match(/^([A-Za-z]+|.)/);
      if (!match) return null;

      return {
        name: match[1],
        end: index + 1 + match[1].length,
      };
    },

    readFirstBracedArgument(latex, index) {
      let cursor = index;
      while (/\s/.test(latex[cursor] || "")) cursor++;
      if (latex[cursor] !== "{") return null;

      let depth = 0;
      for (let i = cursor; i < latex.length; i++) {
        const char = latex[i];
        if ((char === "{" || char === "}") && latexSourceCollector.isEscaped(latex, i)) {
          continue;
        }
        if (char === "{") depth++;
        if (char === "}") depth--;
        if (depth === 0) return { start: cursor, end: i };
      }

      return null;
    },

    applyReplacements(latex, replacements) {
      const sorted = replacements.sort((a, b) => b.start - a.start);

      let next = latex;
      for (const replacement of sorted) {
        next =
          next.slice(0, replacement.start) +
          replacement.value +
          next.slice(replacement.end);
      }
      return next;
    },

    normalizeBareUnits(latex) {
      const skipRanges = this.textArgumentRanges(latex);
      const exponent = String.raw`(?:\^\{[+-]?\d+\}|\^[+-]?\d+|[\u00b2\u00b3])`;
      const token = String.raw`(?:\\mu|[\p{L}\\]+)(?:\s*${exponent})?`;
      const separator = String.raw`(?:\/|\*|\.|\u00b7|\\cdot)`;
      const unitExpression = String.raw`${token}(?:\s*${separator}\s*${token})*`;
      const unitAfterNumber = new RegExp(
        String.raw`(\p{Nd}+(?:[.,\u066b\u066c\u00a0\u202f]\p{Nd}+)*(?:\s*\\[,;:!]\s*|\s+|~))(` +
          unitExpression +
          ")",
        "gu"
      );

      let next = latex.replace(unitAfterNumber, (match, prefix, unit, offset, source) => {
        if (/^\s+\p{L}/u.test(source.slice(offset + match.length))) return match;
        if (source[offset + match.length] === "_") return match;
        if (this.isInsideRange(offset + prefix.length, skipRanges)) return match;

        const normalized = unitNormalizer.normalizeSymbolExpression(unit);
        return normalized ? `${prefix}${normalized}` : match;
      });

      const whole = next.trim();
      if (unitNormalizer.hasLocalizedCharacters(whole)) {
        const normalizedWhole = unitNormalizer.normalizeUnitText(whole);
        if (normalizedWhole) {
          const start = next.indexOf(whole);
          return `${next.slice(0, start)}${normalizedWhole}${next.slice(start + whole.length)}`;
        }
      }

      const contextualFactor = /[\p{Script=Cyrillic}]+(?:\s*(?:\^\{[+-]?\d+\}|\^[+-]?\d+|[\u00b2\u00b3]))?/gu;
      next = next.replace(contextualFactor, (factor, offset, source) => {
        if (this.isInsideRange(offset, skipRanges)) return factor;
        const before = source.slice(Math.max(0, offset - 16), offset);
        const after = source.slice(offset + factor.length, offset + factor.length + 16);
        const unitContext =
          /(?:\d|~|\/|\(|\\cdot)\s*$/u.test(before) ||
          /(?:\\frac\{|\}\{)\s*$/u.test(before) ||
          /^\s*(?:\^|\/|\)|\\cdot)/u.test(after);
        if (!unitContext) return factor;
        return unitNormalizer.normalizeUnitText(factor) || factor;
      });

      return next;
    },

    textArgumentRanges(latex) {
      const ranges = [];
      this.walkLatex(latex, 0, latex.length, (macro) => {
        if (TRANSLATABLE_TEXT_MACROS.has(macro.name)) {
          ranges.push({ start: macro.argumentStart, end: macro.argumentEnd });
          return false;
        }
        if (
          !UNIT_MACROS.has(macro.name) &&
          !NEVER_TRANSLATE_MACROS.has(macro.name)
        ) {
          ranges.push({ start: macro.argumentStart, end: macro.argumentEnd });
          return false;
        }
        return undefined;
      });
      return ranges;
    },

    isInsideRange(offset, ranges) {
      return ranges.some((range) => offset >= range.start && offset < range.end);
    },
  };

  class MathShieldRuntime {
    constructor() {
      this.protectedNodes = new WeakSet();
      this.processedLatex = new WeakMap();
      this.pendingRoots = new Set();
      this.isFlushing = false;
      this.flushSoon = debounce(() => this.flush(), DEFAULT_DEBOUNCE_MS);
    }

    start() {
      const root = getDocumentRoot();
      domShield.protectAll(document, this.protectedNodes);
      this.scheduleProcess(root);
      this.startObserver();
    }

    startObserver() {
      const observer = new MutationObserver((mutations) => {
        const roots = this.collectAffectedRoots(mutations);
        for (const root of roots) {
          domShield.protectAll(root, this.protectedNodes);
          this.scheduleProcess(root);
        }
      });

      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "translate"],
      });
    }

    collectAffectedRoots(mutations) {
      const roots = new Set();

      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          const element = isElement(node) ? node : node.parentElement;
          if (element) roots.add(this.normalizeRoot(element));
        }

        if (mutation.type === "characterData" && mutation.target?.parentElement) {
          roots.add(this.normalizeRoot(mutation.target.parentElement));
        }

        if (mutation.type === "attributes") {
          const target = mutation.target;
          if (target === document.documentElement) {
            roots.add(getDocumentRoot());
          } else if (isElement(target) && target.matches(MATH_SELECTORS)) {
            roots.add(this.normalizeRoot(target));
          }
        }
      }

      return roots;
    }

    normalizeRoot(node) {
      return node.closest(".MathJax_Display, mjx-container, .katex-display") || node;
    }

    scheduleProcess(root) {
      if (!root) return;
      this.pendingRoots.add(root);
      this.flushSoon();
    }

    async flush() {
      if (this.isFlushing) return;
      this.isFlushing = true;

      try {
        while (this.pendingRoots.size) {
          const roots = [...this.pendingRoots].filter((root) => root.isConnected !== false);
          this.pendingRoots.clear();

          const changedRoots = [];
          for (const root of roots) {
            const changed = await this.processRoot(root);
            changedRoots.push(...changed);
          }

          if (changedRoots.length) {
            await this.rerender(changedRoots);
            for (const root of changedRoots) {
              domShield.protectAll(root, this.protectedNodes);
            }
          }
        }
      } finally {
        this.isFlushing = false;
      }
    }

    async processRoot(root) {
      const sources = latexSourceCollector.collect(root);
      const changedRoots = [];

      for (const source of sources) {
        const oldLatex = source.getLatex();
        const oldHash = hashString(oldLatex);

        if (this.getStoredHash(source) === oldHash) continue;

        const newLatex = await source.transform(oldLatex);

        const newHash = hashString(newLatex);
        if (source.getLatex() !== oldLatex) continue;

        if (newLatex !== oldLatex) {
          source.setLatex(newLatex);
          this.setStoredHash(source, newHash);
          changedRoots.push(source.root || root);
        } else {
          this.setStoredHash(source, oldHash);
        }
      }

      return changedRoots;
    }

    getStoredHash(source) {
      if (source.node?.dataset) return source.node.dataset.mathshieldHash;
      return this.processedLatex.get(source.node);
    }

    setStoredHash(source, hash) {
      if (source.node?.dataset) {
        source.node.dataset.mathshieldHash = hash;
        return;
      }

      this.processedLatex.set(source.node, hash);
    }

    async rerender(roots) {
      const ids = [];
      for (const root of roots) {
        if (!isElement(root)) continue;
        const id = root.dataset.mathshieldRenderId || crypto.randomUUID();
        root.dataset.mathshieldRenderId = id;
        ids.push(id);
      }

      if (!ids.length) return;

      try {
        await chrome.runtime.sendMessage({
          type: "mathshield-rerender",
          rootIds: [...new Set(ids)],
        });
      } catch {
        // Rendering is best effort; source LaTeX is still preserved.
      }
    }
  }

  if (globalThis.__MATHSHIELD_TEST_MODE__ === true) {
    globalThis.MathShieldTest = {
      async normalizeUnit(value, locale, output = "latex") {
        await unitNormalizer.loadGeneratedDatabase();
        unitNormalizer.activeLocaleKeys = unitNormalizer.resolveLocaleKeys([locale]);
        return unitNormalizer.normalizeUnitText(value, { output });
      },
      async transformLatex(latex, locale) {
        await unitNormalizer.loadGeneratedDatabase();
        return latexTransformer.transform(latex, {
          sourceLocales: [locale],
        });
      },
    };
    return;
  }

  const runtime = new MathShieldRuntime();
  if (document.documentElement) {
    runtime.start();
  } else {
    const bootstrapObserver = new MutationObserver(() => {
      if (!document.documentElement) return;
      bootstrapObserver.disconnect();
      runtime.start();
    });
    bootstrapObserver.observe(document, { childList: true });
  }
})();
