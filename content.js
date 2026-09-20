const TEXT_COMMANDS = /\\(text|mbox|mathrm|textbf|textit|textrm|textsf|texttt)\{([^}]*)\}/g;

const PREFIXES = {
  "мк": "µ",
  "н": "n",
  "п": "p",
  "ф": "f",
  "м": "m",
  "к": "k",
  "М": "M",
  "Г": "G",
  "Т": "T",
};

const BASE_UNITS = {
  "м": "m",
  "г": "g",
  "с": "s",
  "А": "A",
  "В": "V",
  "Ом": "\\Omega",
  "Гц": "Hz",
  "Дж": "J",
  "Кл": "C",
  "К": "K",
  "моль": "mol",
  "л": "L",
};

function watchAndProtectMathJax() {
  const protect = (el) => {
    el.classList.add("notranslate");
    el.setAttribute("translate", "no");
    if (el.classList.contains("MathJax")) {
      el.style.marginLeft = "0.3em";
      el.style.marginRight = "0.3em";
    }
  };

  const scan = (root) =>
    root.querySelectorAll(".MathJax, .MathJax_Preview, .MathJax_Display").forEach(protect);

  scan(document);

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.classList?.contains("MathJax") ||
          node.classList?.contains("MathJax_Display") ||
          node.classList?.contains("MathJax_Preview")
        ) {
          protect(node);
        }
        node.querySelectorAll?.(".MathJax, .MathJax_Display, .MathJax_Preview").forEach(protect);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

function waitForTranslation(callback) {
  const html = document.documentElement;

  const run = () => {
    if (
      html.classList.contains("translated-ltr") ||
      html.classList.contains("translated-rtl")
    ) {
      observer.disconnect();
      setTimeout(callback, 500);
      return true;
    }
    return false;
  };

  const observer = new MutationObserver(run);
  if (run()) return;

  observer.observe(html, { attributes: true, attributeFilter: ["class"] });
}

function convertUnit(word) {
  for (const [pOrig, pConv] of Object.entries(PREFIXES).sort(
    (a, b) => b[0].length - a[0].length
  )) {
    if (word.startsWith(pOrig)) {
      const rest = word.slice(pOrig.length);
      if (BASE_UNITS[rest]) return pConv + BASE_UNITS[rest];
    }
  }
  return BASE_UNITS[word] || null;
}

function replaceUnitsSmart(latex) {
  return latex.replace(
    /(?<![A-Za-z\\])([\u0400-\u04FF]{1,6})(?=[^A-Za-z]|$)/g,
    (match) => convertUnit(match) || match
  );
}

function extractHumanTexts(latex) {
  const texts = new Set();

  for (const match of latex.matchAll(TEXT_COMMANDS)) {
    const content = match[2];
    if (!content?.trim()) continue;
    content.match(/[\u0400-\u04FF]+/g)?.forEach((word) => {
      if (word.length >= 2) texts.add(word);
    });
  }

  return [...texts];
}

async function translateBatch(texts, targetLang) {
  if (!texts.length) return {};

  const res = await fetch(
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(texts.join("\n"))}`
  );

  if (!res.ok) throw new Error(`Translate API error: ${res.status}`);

  const data = await res.json();
  const flat = data[0].map((x) => x[0]).join("").split("\n");
  return Object.fromEntries(texts.map((t, i) => [t, flat[i] ?? t]));
}

function applyTranslations(latex, map) {
  let updated = replaceUnitsSmart(latex);

  updated = updated.replace(TEXT_COMMANDS, (_, cmd, content) => {
    let text = replaceUnitsSmart(content);

    if (cmd !== "mathrm") {
      for (const [orig, trans] of Object.entries(map)) {
        const escaped = orig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

        text = text.replace(
          new RegExp(`(^|[^\\p{L}])${escaped}(?=[^\\p{L}]|$)`, "gu"),
          (_, left) => left + trans
        );
      }
    }

    return `\\${cmd}{${text}}`;
  });

  return updated;
}

async function fixMath() {
  const scripts = document.querySelectorAll('script[type*="math/tex"]');
  if (!scripts.length) return;

  const texts = new Set();
  scripts.forEach((s) => extractHumanTexts(s.textContent).forEach((t) => texts.add(t)));

  let translations = {};
  if (texts.size) {
    try {
      translations = await translateBatch([...texts], navigator.language.split("-")[0]);
    } catch {}
  }

  let changed = 0;
  scripts.forEach((s) => {
    const updated = applyTranslations(s.textContent, translations);
    if (updated !== s.textContent) {
      s.textContent = updated;
      changed++;
    }
  });

  if (changed > 0) chrome.runtime.sendMessage({ type: "rerender-mathjax" });
}

watchAndProtectMathJax();
waitForTranslation(() => setTimeout(fixMath, 300));
