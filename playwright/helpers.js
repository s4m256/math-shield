const fs = require("node:fs/promises");
const path = require("node:path");

const VISUAL_MATH_SELECTOR = [
  ".MathJax_CHTML",
  ".MathJax_SVG",
  "mjx-container",
  ".katex-display",
  ".katex",
].join(",");

function attachRuntimeDiagnostics(page) {
  const diagnostics = {
    consoleErrors: [],
    pageErrors: [],
    requestFailures: [],
    errorResponses: [],
  };
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => diagnostics.pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    diagnostics.requestFailures.push({
      url: request.url(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText || "unknown",
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.errorResponses.push({ url: response.url(), status: response.status() });
    }
  });
  return diagnostics;
}

function isTelemetryUrl(url) {
  return /(?:google-analytics\.com|mc\.yandex\.|googletagmanager\.com)/i.test(url);
}

function relevantRuntimeErrors(diagnostics, extensionId) {
  const extensionPrefix = extensionId ? `chrome-extension://${extensionId}/` : null;
  return {
    consoleErrors: diagnostics.consoleErrors.filter(
      (message) => !/favicon|analytics|yandex/i.test(message)
    ),
    pageErrors: diagnostics.pageErrors,
    requestFailures: diagnostics.requestFailures.filter(
      (failure) =>
        !isTelemetryUrl(failure.url) &&
        (failure.resourceType === "document" ||
          failure.resourceType === "script" ||
          Boolean(extensionPrefix && failure.url.startsWith(extensionPrefix)))
    ),
    extensionFailures: diagnostics.requestFailures.filter(
      (failure) => Boolean(extensionPrefix && failure.url.startsWith(extensionPrefix))
    ),
  };
}

async function collectInventory(page) {
  return page.evaluate((visualSelector) => {
    const round = (value) => Math.round(value * 10) / 10;
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: round(rect.x + scrollX),
        y: round(rect.y + scrollY),
        width: round(rect.width),
        height: round(rect.height),
        right: round(rect.right + scrollX),
        bottom: round(rect.bottom + scrollY),
      };
    };
    const sourceNodes = [...document.querySelectorAll('script[type*="math/tex"]')];
    const visualNodes = [...document.querySelectorAll(visualSelector)].filter(
      (element) => !element.parentElement?.closest(visualSelector)
    );

    const formulas = visualNodes.map((element, index) => {
      const source =
        element.nextElementSibling?.matches?.('script[type*="math/tex"]')
          ? element.nextElementSibling
          : null;
      const sourceIndex = source ? sourceNodes.indexOf(source) : -1;
      const rect = rectOf(element);
      const style = getComputedStyle(element);
      const displayMode =
        source?.type.includes("mode=display") ||
        element.matches('mjx-container[display="true"], .MathJax_Display, .katex-display') ||
        style.display === "block";
      let clippedVertically = false;
      for (let ancestor = element.parentElement; ancestor && ancestor !== document.body; ancestor = ancestor.parentElement) {
        const ancestorStyle = getComputedStyle(ancestor);
        if (/hidden|clip/.test(ancestorStyle.overflowY)) {
          const ancestorRect = rectOf(ancestor);
          if (rect.y < ancestorRect.y - 1 || rect.bottom > ancestorRect.bottom + 1) {
            clippedVertically = true;
            break;
          }
        }
      }
      return {
        index,
        tag: element.tagName,
        className: typeof element.className === "string" ? element.className : "",
        sourceIndex,
        source: source?.textContent || null,
        text: element.textContent || "",
        html: element.outerHTML,
        signature: (source?.textContent || element.textContent || "").replace(/\s+/g, " ").trim(),
        rect,
        displayMode: Boolean(displayMode),
        hidden:
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0,
        clippedVertically,
      };
    });

    const overlap = (a, b) => ({
      width: Math.min(a.right, b.right) - Math.max(a.x, b.x),
      height: Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y),
    });
    const overlaps = [];
    const duplicates = [];
    const displayFormulas = formulas.filter((formula) => formula.displayMode);
    for (let left = 0; left < displayFormulas.length; left += 1) {
      for (let right = left + 1; right < displayFormulas.length; right += 1) {
        const a = displayFormulas[left];
        const b = displayFormulas[right];
        const intersection = overlap(a.rect, b.rect);
        if (intersection.width > 1 && intersection.height > 1) {
          const pair = { left: a.index, right: b.index, intersection };
          overlaps.push(pair);
          if (a.signature && a.signature === b.signature) duplicates.push(pair);
        }
      }
    }
    const formulasBySource = new Map();
    for (const formula of formulas) {
      if (formula.sourceIndex < 0) continue;
      const previous = formulasBySource.get(formula.sourceIndex);
      if (previous !== undefined) {
        const pair = { left: previous, right: formula.index, reason: "same-source" };
        if (!duplicates.some((item) => item.left === pair.left && item.right === pair.right)) {
          duplicates.push(pair);
        }
      } else {
        formulasBySource.set(formula.sourceIndex, formula.index);
      }
    }

    return {
      url: location.href,
      title: document.title,
      lang: document.documentElement.lang,
      counts: {
        mjxContainers: document.querySelectorAll("mjx-container").length,
        mathJaxDisplay: document.querySelectorAll(".MathJax_Display").length,
        mathJaxChtml: document.querySelectorAll(".MathJax_CHTML").length,
        katexDisplay: document.querySelectorAll(".katex-display").length,
        mathMl: document.querySelectorAll("math").length,
        sources: sourceNodes.length,
        visualFormulas: formulas.length,
      },
      protectedCount: document.querySelectorAll("[data-mathshield-protected='true']").length,
      hashedSourceCount: sourceNodes.filter((source) => source.dataset.mathshieldHash).length,
      mathErrors: [
        ...document.querySelectorAll("mjx-merror, .katex-error, [data-mjx-error]"),
      ].map((element) => element.textContent?.trim() || element.outerHTML.slice(0, 300)),
      sources: sourceNodes.map((source, index) => ({
        index,
        type: source.type,
        latex: source.textContent || "",
        hash: source.dataset.mathshieldHash || null,
        protected: source.dataset.mathshieldProtected === "true",
      })),
      formulas,
      overlaps,
      duplicates,
      zeroSize: formulas.filter(
        (formula) => !formula.hidden && (formula.rect.width <= 0 || formula.rect.height <= 0)
      ).map((formula) => formula.index),
      hidden: formulas.filter((formula) => formula.hidden).map((formula) => formula.index),
      clipped: formulas
        .filter((formula) => formula.clippedVertically)
        .map((formula) => formula.index),
    };
  }, VISUAL_MATH_SELECTOR);
}

function stableSignature(inventory) {
  return JSON.stringify({
    counts: inventory.counts,
    sources: inventory.sources.map((source) => [source.latex, source.hash]),
    formulas: inventory.formulas.map((formula) => [
      formula.signature,
      formula.rect.x,
      formula.rect.y,
      formula.rect.width,
      formula.rect.height,
    ]),
  });
}

async function waitForMathStability(page, timeoutMs = 15_000) {
  await page.evaluate(async () => {
    if (document.fonts?.ready) await document.fonts.ready;
    if (globalThis.MathJax?.Hub?.Queue) {
      await new Promise((resolve) => globalThis.MathJax.Hub.Queue(resolve));
    } else if (globalThis.MathJax?.startup?.promise) {
      await globalThis.MathJax.startup.promise;
    }
  });

  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let consecutive = 0;
  let inventory = null;
  while (Date.now() < deadline) {
    inventory = await collectInventory(page);
    const signature = stableSignature(inventory);
    consecutive = signature === previous ? consecutive + 1 : 1;
    if (consecutive >= 3) return { stable: true, inventory };
    previous = signature;
    await page.waitForTimeout(400);
  }
  return { stable: false, inventory: inventory || (await collectInventory(page)) };
}

async function navigateAndCollect(page, url) {
  let response;
  let navigationError = null;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  } catch (error) {
    navigationError = String(error);
  }

  const bodyText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const title = await page.title().catch(() => "");
  const status = response?.status() || null;
  const externalBlock =
    Boolean(navigationError) ||
    Boolean(status && [403, 429, 502, 503, 504].includes(status)) ||
    /captcha|cloudflare|access denied|enable javascript and cookies|temporarily unavailable/i.test(
      `${title}\n${bodyText.slice(0, 1000)}`
    );
  if (externalBlock) {
    return { externalBlock: true, reason: navigationError || `HTTP ${status}: ${title}` };
  }

  const stability = await waitForMathStability(page);
  return { externalBlock: false, status, ...stability };
}

function compareSources(baseline, current) {
  const changes = [];
  const total = Math.max(baseline.sources.length, current.sources.length);
  for (let index = 0; index < total; index += 1) {
    const before = baseline.sources[index]?.latex ?? null;
    const after = current.sources[index]?.latex ?? null;
    if (before !== after) changes.push({ index, before, after });
  }
  return changes;
}

function isExpectedUnitChange(change) {
  return (
    typeof change.before === "string" &&
    typeof change.after === "string" &&
    /[\u0400-\u052f\u0590-\u08ff\u0900-\u097f\u3040-\u30ff\u3400-\u9fff]/u.test(
      change.before
    ) &&
    /\\(?:mathrm|mu|Omega)|\^\{\\circ\}/.test(change.after)
  );
}

function analyzeIteration({ baseline, current, target, diagnostics, extensionId, stable }) {
  const changes = compareSources(baseline, current);
  const unitChanges = changes.filter(isExpectedUnitChange);
  const unexpectedChanges = changes.filter((change) => !isExpectedUnitChange(change));
  const runtimeErrors = relevantRuntimeErrors(diagnostics, extensionId);
  const remainingExpectedFragments = (target.expectedUnitFragments || []).filter((fragment) =>
    current.sources.some((source) => source.latex.includes(fragment))
  );
  const remainingExpectedSourceIndexes = current.sources
    .filter((source) =>
      remainingExpectedFragments.some((fragment) => source.latex.includes(fragment))
    )
    .map((source) => source.index);
  const issues = [];

  if (!extensionId || current.protectedCount === 0 || current.hashedSourceCount === 0) {
    issues.push("No reliable evidence that the unpacked extension processed the page");
  }
  if (!stable) issues.push("Mathematical DOM did not stabilize before timeout");
  if (baseline.counts.sources !== current.counts.sources) {
    issues.push(`Source count changed: ${baseline.counts.sources} -> ${current.counts.sources}`);
  }
  if (baseline.counts.visualFormulas !== current.counts.visualFormulas) {
    issues.push(
      `Rendered formula count changed: ${baseline.counts.visualFormulas} -> ${current.counts.visualFormulas}`
    );
  }
  if (unitChanges.length < target.minimumUnitChanges) {
    issues.push(
      `Expected at least ${target.minimumUnitChanges} unit changes, observed ${unitChanges.length}`
    );
  }
  if (remainingExpectedFragments.length) {
    issues.push(`Localized unit fragments remain: ${remainingExpectedFragments.join(", ")}`);
  }
  if (unexpectedChanges.length) {
    issues.push(`Unexpected non-unit source changes: ${unexpectedChanges.length}`);
  }
  if (current.mathErrors.length) issues.push(`Math renderer errors: ${current.mathErrors.length}`);
  if (current.hidden.length) issues.push(`Hidden formulas: ${current.hidden.join(", ")}`);
  if (current.zeroSize.length) issues.push(`Zero-size formulas: ${current.zeroSize.join(", ")}`);
  if (current.overlaps.length) issues.push(`Overlapping display formulas: ${current.overlaps.length}`);
  if (current.duplicates.length) issues.push(`Duplicated formulas: ${current.duplicates.length}`);
  if (current.clipped.length) issues.push(`Vertically clipped formulas: ${current.clipped.length}`);
  if (runtimeErrors.extensionFailures.length || runtimeErrors.pageErrors.length) {
    issues.push(
      `Runtime errors: ${runtimeErrors.extensionFailures.length + runtimeErrors.pageErrors.length}`
    );
  }

  return {
    issues,
    changes,
    unitChanges,
    unexpectedChanges,
    remainingExpectedFragments,
    remainingExpectedSourceIndexes,
    runtimeErrors,
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function screenshotProblems(page, inventory, artifactDir, extraSourceIndexes = []) {
  const indexes = new Set([
    ...inventory.zeroSize,
    ...inventory.hidden,
    ...inventory.clipped,
    ...inventory.overlaps.flatMap((pair) => [pair.left, pair.right]),
    ...inventory.duplicates.flatMap((pair) => [pair.left, pair.right]),
  ]);
  for (const sourceIndex of extraSourceIndexes) {
    const formula = inventory.formulas.find((candidate) => candidate.sourceIndex === sourceIndex);
    if (formula) indexes.add(formula.index);
  }
  for (const index of indexes) {
    const formula = inventory.formulas[index];
    if (!formula || formula.rect.width <= 0 || formula.rect.height <= 0) continue;
    await page.screenshot({
      path: path.join(artifactDir, `formula-${index}.png`),
      clip: formula.rect,
    }).catch(() => {});
  }
}

module.exports = {
  analyzeIteration,
  attachRuntimeDiagnostics,
  navigateAndCollect,
  screenshotProblems,
  stableSignature,
  writeJson,
};
