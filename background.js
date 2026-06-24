chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "mathshield-rerender" || !sender.tab?.id) return false;

  chrome.scripting
    .executeScript({
      target: { tabId: sender.tab.id },
      world: "MAIN",
      args: [msg.rootIds || []],
      func: async (rootIds) => {
        const protect = (el) => {
          el.classList.add("notranslate");
          el.setAttribute("translate", "no");
          el.setAttribute("data-mathshield-protected", "true");
          if (el.classList.contains("MathJax") || el.tagName === "MJX-CONTAINER") {
            el.style.marginLeft ||= "0.3em";
            el.style.marginRight ||= "0.3em";
          }
        };

        const escapeAttribute = (value) => String(value).replace(/["\\]/g, "\\$&");

        const roots = rootIds
          .map((id) => document.querySelector(`[data-mathshield-render-id="${escapeAttribute(id)}"]`))
          .filter(Boolean);

        const targets = roots.length ? roots : [document.body || document.documentElement];

        const protectRenderedMath = () => {
          document
            .querySelectorAll(
              ".MathJax, .MathJax_Preview, .MathJax_Display, mjx-container, .katex, .katex-display, math"
            )
            .forEach(protect);
        };

        if (window.MathJax?.typesetClear && window.MathJax?.typesetPromise) {
          try {
            window.MathJax.typesetClear(targets);
            await window.MathJax.typesetPromise(targets);
            protectRenderedMath();
            return { engine: "mathjax-v3" };
          } catch {}
        }

        if (window.MathJax?.typesetPromise) {
          try {
            await window.MathJax.typesetPromise(targets);
            protectRenderedMath();
            return { engine: "mathjax-v3" };
          } catch {}
        }

        if (window.MathJax?.Hub?.Queue) {
          await new Promise((resolve) => {
            const queue = window.MathJax.Hub.Queue;
            for (const target of targets) {
              queue(["Reprocess", window.MathJax.Hub, target]);
            }
            queue(() => {
              protectRenderedMath();
              resolve();
            });
          });
          return { engine: "mathjax-v2" };
        }

        if (typeof window.renderMathInElement === "function") {
          for (const target of targets) {
            try {
              window.renderMathInElement(target, {
                throwOnError: false,
                delimiters: [
                  { left: "$$", right: "$$", display: true },
                  { left: "\\[", right: "\\]", display: true },
                  { left: "\\(", right: "\\)", display: false },
                  { left: "$", right: "$", display: false },
                ],
              });
            } catch {}
          }
          protectRenderedMath();
          return { engine: "katex" };
        }

        protectRenderedMath();
        return { engine: "none" };
      },
    })
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: String(error) }));

  return true;
});
