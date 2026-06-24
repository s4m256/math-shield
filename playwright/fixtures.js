const base = require("@playwright/test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

async function removeWithRetry(target) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

async function findServiceWorker(context) {
  const existing = context.serviceWorkers()[0];
  if (existing) return existing;
  try {
    return await context.waitForEvent("serviceworker", { timeout: 10_000 });
  } catch {
    return null;
  }
}

const test = base.test.extend({
  contextFactory: async ({ playwright }, use, testInfo) => {
    const sessions = new Set();

    await use(async ({ artifactDir, extension = true }) => {
      await fs.mkdir(artifactDir, { recursive: true });
      const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "mathshield-e2e-"));
      const videoDir = path.join(artifactDir, "video");
      const args = extension
        ? [
            `--disable-extensions-except=${projectRoot}`,
            `--load-extension=${projectRoot}`,
          ]
        : [];

      const context = await playwright.chromium.launchPersistentContext(profileDir, {
        channel: "chromium",
        headless: process.env.MATHSHIELD_HEADED !== "1",
        viewport: { width: 1440, height: 1000 },
        recordVideo: { dir: videoDir, size: { width: 1440, height: 1000 } },
        args,
      });
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

      const page = context.pages()[0] || (await context.newPage());
      const serviceWorker = extension ? await findServiceWorker(context) : null;
      let finished = false;

      const session = {
        page,
        extensionId: serviceWorker?.url().split("/")[2] || null,
        async finish({ failed = false } = {}) {
          if (finished) return;
          finished = true;
          const video = page.video();
          const tracePath = path.join(artifactDir, "trace.zip");
          await context.tracing.stop(failed ? { path: tracePath } : undefined);
          await context.close();
          if (!failed) await removeWithRetry(videoDir);
          await removeWithRetry(profileDir);
          sessions.delete(session);
          return {
            trace: failed ? tracePath : null,
            video: failed && video ? await video.path().catch(() => null) : null,
          };
        },
      };
      sessions.add(session);
      return session;
    });

    for (const session of sessions) {
      await session.finish({ failed: testInfo.status !== testInfo.expectedStatus });
    }
  },
});

module.exports = { test, projectRoot };
