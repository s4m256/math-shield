const fs = require("node:fs/promises");
const path = require("node:path");
const { test, projectRoot } = require("./fixtures");
const {
  analyzeIteration,
  attachRuntimeDiagnostics,
  navigateAndCollect,
  screenshotProblems,
  stableSignature,
  writeJson,
} = require("./helpers");

const TARGETS = [
  {
    id: "4812",
    url: "https://pho.rs/p/4812",
    minimumUnitChanges: 0,
    expectedUnitFragments: ["м^3"],
  },
  {
    id: "4174",
    url: "https://pho.rs/p/4174",
    minimumUnitChanges: 6,
    expectedUnitFragments: ["эВ", "нм", "~К", "~м", "Вт", "м^2"],
  },
  {
    id: "4191",
    url: "https://pho.rs/p/4191",
    minimumUnitChanges: 10,
    expectedUnitFragments: [
      "мВ",
      "Кл",
      "Дж/К",
      "моль",
      "м^{-3}",
      "ммоль/л",
      "Ф/м",
      "нм",
      "мкА",
      "см^2",
      "Ом",
      "м^{-2}",
      "мкм",
    ],
  },
];

const requestedIterations = Number.parseInt(process.env.MATHSHIELD_ITERATIONS || "3", 10);
const iterations = Number.isFinite(requestedIterations)
  ? Math.min(5, Math.max(1, requestedIterations))
  : 3;
const artifactRoot = path.join(projectRoot, "artifacts", "e2e");

function targetUrl(originalUrl) {
  const template = process.env.MATHSHIELD_TRANSLATED_URL_TEMPLATE;
  if (!template) return originalUrl;
  return template
    .replaceAll("{url}", originalUrl)
    .replaceAll("{encodedUrl}", encodeURIComponent(originalUrl))
    .replaceAll("{target}", process.env.MATHSHIELD_TARGET_LANGUAGE || "pt");
}

for (const target of TARGETS) {
  test(`page ${target.id} remains normalized and visually stable`, async ({ contextFactory }, testInfo) => {
    const targetDir = path.join(artifactRoot, target.id);
    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    const url = targetUrl(target.url);

    const baselineDir = path.join(targetDir, "baseline");
    const baselineSession = await contextFactory({ artifactDir: baselineDir, extension: false });
    const baselineDiagnostics = attachRuntimeDiagnostics(baselineSession.page);
    const baselineResult = await navigateAndCollect(baselineSession.page, url);
    if (baselineResult.externalBlock) {
      await writeJson(path.join(baselineDir, "diagnostics.json"), {
        status: "inconclusive",
        reason: baselineResult.reason,
        runtime: baselineDiagnostics,
      });
      await baselineSession.finish({ failed: true });
      testInfo.annotations.push({ type: "inconclusive", description: baselineResult.reason });
      test.skip(true, `External page unavailable: ${baselineResult.reason}`);
    }
    await baselineSession.page.screenshot({
      path: path.join(baselineDir, "full-page.png"),
      fullPage: true,
    });
    const baseline = baselineResult.inventory;
    await writeJson(path.join(baselineDir, "inventory.json"), {
      status: "baseline",
      stable: baselineResult.stable,
      inventory: baseline,
      runtime: baselineDiagnostics,
    });
    await baselineSession.finish({ failed: !baselineResult.stable });

    const reports = [];
    const failures = [];
    const inconclusive = [];
    const signatures = [];

    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      const artifactDir = path.join(targetDir, `iteration-${iteration}`);
      const session = await contextFactory({ artifactDir, extension: true });
      const diagnostics = attachRuntimeDiagnostics(session.page);
      const result = await navigateAndCollect(session.page, url);

      if (result.externalBlock) {
        const report = {
          iteration,
          status: "inconclusive",
          reason: result.reason,
          extensionId: session.extensionId,
          runtime: diagnostics,
        };
        inconclusive.push(report);
        reports.push(report);
        await writeJson(path.join(artifactDir, "diagnostics.json"), report);
        await session.finish({ failed: true });
        continue;
      }

      await session.page.screenshot({
        path: path.join(artifactDir, "full-page.png"),
        fullPage: true,
      });
      const current = result.inventory;
      const analysis = analyzeIteration({
        baseline,
        current,
        target,
        diagnostics,
        extensionId: session.extensionId,
        stable: result.stable,
      });
      signatures.push(stableSignature(current));
      const failed = analysis.issues.length > 0;
      await screenshotProblems(
        session.page,
        current,
        artifactDir,
        [
          ...analysis.unexpectedChanges.map((change) => change.index),
          ...analysis.remainingExpectedSourceIndexes,
        ]
      );
      const report = {
        iteration,
        status: failed ? "failed" : "passed",
        url,
        extensionId: session.extensionId,
        stable: result.stable,
        inventory: current,
        analysis,
        runtime: diagnostics,
      };
      reports.push(report);
      if (failed) failures.push(report);
      const diagnosticPath = path.join(artifactDir, "diagnostics.json");
      await writeJson(diagnosticPath, report);
      const retained = await session.finish({ failed });
      report.artifacts = {
        diagnostics: diagnosticPath,
        screenshot: path.join(artifactDir, "full-page.png"),
        ...retained,
      };
      await writeJson(diagnosticPath, report);
    }

    if (new Set(signatures).size > 1) {
      failures.push({ status: "failed", issues: ["Final mathematical structure varied between iterations"] });
    }

    const summary = {
      pageId: target.id,
      url,
      iterations,
      status: failures.length ? "failed" : inconclusive.length ? "inconclusive" : "passed",
      baseline: {
        formulas: baseline.counts.visualFormulas,
        sources: baseline.counts.sources,
        artifacts: baselineDir,
      },
      unitChanges: reports.reduce((total, report) => total + (report.analysis?.unitChanges.length || 0), 0),
      failures: failures.map((failure) => failure.analysis?.issues || failure.issues),
      inconclusive: inconclusive.map((report) => report.reason),
      reports: reports.map((report) => ({
        iteration: report.iteration,
        status: report.status,
        formulas: report.inventory?.counts.visualFormulas || 0,
        unitChanges: report.analysis?.unitChanges.length || 0,
        errors: report.analysis?.issues || [report.reason].filter(Boolean),
        artifacts: path.join(targetDir, `iteration-${report.iteration}`),
      })),
    };
    const summaryPath = path.join(targetDir, "summary.json");
    await writeJson(summaryPath, summary);
    await testInfo.attach(`page-${target.id}-summary`, {
      path: summaryPath,
      contentType: "application/json",
    });

    if (failures.length) {
      throw new Error(
        failures
          .flatMap((failure) => failure.analysis?.issues || failure.issues || [])
          .filter((issue, index, all) => all.indexOf(issue) === index)
          .join("; ")
      );
    }
    if (inconclusive.length) {
      testInfo.annotations.push({
        type: "inconclusive",
        description: inconclusive.map((report) => report.reason).join("; "),
      });
      test.skip(true, "One or more iterations were inconclusive due to external availability");
    }
  });
}
