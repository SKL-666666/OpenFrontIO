/**
 * Real-browser smoke test: drives headless Chrome over CDP and prints every
 * console message, uncaught exception and failed request the page produces.
 * There is no Playwright in this repo (install runs with --ignore-scripts), so
 * this is how client changes get checked against the running game instead of
 * only against Vitest's jsdom.
 *
 * Usage:
 *   node scripts/lan-host.mjs --port 9415      # serve the built client
 *   node scripts/browser-smoke.mjs [--click]   # in a second shell
 *
 *   (nothing)  load the page, dump console/errors after 6s
 *   --click    then press Start in the single-player modal, poll the loading
 *              overlay for 31s, and save a screenshot to .browser-smoke.png
 *
 * SMOKE_PORT picks the port (default 9415), SMOKE_CHROME the browser binary.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";

const CHROME =
  process.env.SMOKE_CHROME ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.env.SMOKE_PORT ?? 9415);
const CDP_PORT = 9333;
const PAGE = `http://127.0.0.1:${PORT}/`;
const doClick = process.argv.includes("--click");
const doGod = process.argv.includes("--god");

const say = (m) => {
  console.log(m);
  try {
    appendFileSync(".browser-smoke.log", m + "\n");
  } catch {
    // A failed log write must not take the run down with it.
  }
};
say(`boot chrome=${CHROME} port=${CDP_PORT}`);

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${CDP_PORT}`,
    "--user-data-dir=" + process.cwd() + "\\.browser-smoke-profile",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--window-size=1280,900",
    "about:blank",
  ],
  { stdio: "ignore" },
);
chrome.on("error", (e) => say(`chrome spawn error: ${e.message}`));
chrome.on("exit", (c, s) => say(`chrome exit code=${c} signal=${s}`));
setTimeout(() => {
  say("HARD TIMEOUT after 120s");
  chrome.kill();
  process.exit(2);
}, 120_000).unref();

function getJson(pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: CDP_PORT, path: pathname, method },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(
              new Error(`bad json from ${pathname}: ${body.slice(0, 200)}`),
            );
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let targets = [];
for (let i = 0; i < 40; i++) {
  try {
    targets = await getJson("/json/list");
    say(`/json/list ok (${targets.length} targets)`);
    break;
  } catch (e) {
    if (i % 5 === 0) say(`  cdp not up yet (${i}): ${e.message}`);
    await sleep(250);
  }
}
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error(
    "NO PAGE TARGET. targets:",
    targets.map((t) => t.type),
  );
  chrome.kill();
  process.exit(1);
}

say(`connecting ws: ${page.webSocketDebuggerUrl}`);
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 1 << 28 });
ws.on("open", () => say("ws OPEN"));
ws.on("error", (e) => say(`ws error: ${e.message}`));
ws.on("close", (c, r) => say(`ws close code=${c} reason=${r}`));
let seq = 0;
const pending = new Map();
const waiters = [];

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no reply to ${method} within 15s`));
    }, 15_000);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
  });
}

function onEvent(method, fn) {
  waiters.push({ method, fn });
}

const lines = [];
function log(kind, text) {
  const line = `[${kind}] ${text}`;
  lines.push(line);
  console.log(line);
}

await new Promise((r) => ws.on("open", r));

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);
  if (msg.id !== undefined) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(JSON.stringify(msg.error)));
      } else {
        p.resolve(msg.result);
      }
    }
    return;
  }
  for (const w of waiters) if (w.method === msg.method) w.fn(msg.params);
});

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");

onEvent("Runtime.consoleAPICalled", (p) => {
  const text = (p.args ?? [])
    .map((a) =>
      a.type === "string" || a.type === "number" || a.type === "boolean"
        ? String(a.value)
        : (a.description ?? a.type),
    )
    .join(" ");
  log(p.type, text);
});
onEvent("Runtime.exceptionThrown", (p) => {
  const d = p.exceptionDetails ?? {};
  const e = d.exception ?? {};
  log(
    "EXCEPTION",
    `${e.description ?? d.text ?? "?"} @ ${d.url ?? "?"}:${d.lineNumber ?? "?"}`,
  );
});
onEvent("Log.entryAdded", (p) => {
  const e = p.entry ?? {};
  log(`log:${e.level}`, `${e.text} ${e.url ?? ""}`);
});
onEvent("Network.loadingFailed", (p) => {
  if (p.type === "Document" || p.type === "Script" || p.type === "Worker")
    log("NET-FAIL", `${p.type} ${p.errorText} ${p.blockedReason ?? ""}`);
});

async function evalJs(expression, awaitPromise = true) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception ?? {};
    return { error: e.description ?? r.exceptionDetails.text };
  }
  return { value: r.result.value };
}

async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sleep(35);
}

async function rightClickAt(x, y) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "right",
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "right",
    clickCount: 1,
  });
  await sleep(60);
}

// A spread of points over the middle of the canvas, away from the HUD panels.
async function clickGrid() {
  for (let x = 300; x <= 980; x += 120) {
    for (let y = 200; y <= 700; y += 100) {
      await clickAt(x, y);
    }
  }
}

await send("Page.navigate", { url: PAGE });
await sleep(6000);

console.log("=== after load ===");
console.log(
  JSON.stringify(
    await evalJs(
      `(() => ({
      hasLangSelector: !!document.querySelector("lang-selector"),
      hasPageFooter: !!document.querySelector("page-footer"),
      hasPlayPage: !!document.querySelector("play-page"),
      soloButtons: [...document.querySelectorAll("button")]
        .filter((b) => /solo/i.test(b.textContent || ""))
        .map((b) => (b.textContent || "").trim().slice(0, 40)),
      title: document.title,
    }))()`,
      false,
    ),
  ),
);

if (doClick) {
  console.log("=== clicking SOLO ===");
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const btn = [...document.querySelectorAll("button")]
          .find((b) => /solo/i.test(b.textContent || "") && b.offsetParent !== null)
          || [...document.querySelectorAll("button")].find((b) => /solo/i.test(b.textContent || ""));
        if (!btn) return { found: false };
        btn.click();
        return { found: true, text: (btn.textContent||"").trim().slice(0,40) };
      })()`,
        false,
      ),
    ),
  );
  await sleep(2500);

  console.log("=== modal state ===");
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const m = document.querySelector("single-player-modal");
        return {
          modal: !!m,
          starting: m ? m.starting : null,
          startButtons: [...document.querySelectorAll("button")]
            .filter((b) => /start|开始/i.test(b.textContent || ""))
            .map((b) => (b.textContent||"").trim().slice(0,40)),
        };
      })()`,
        false,
      ),
    ),
  );

  console.log("=== clicking Start ===");
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const btn = [...document.querySelectorAll("button")]
          .find((b) => /^(start|开始)/i.test((b.textContent||"").trim()));
        if (!btn) return { found: false };
        btn.click();
        return { found: true, text: (btn.textContent||"").trim().slice(0,40) };
      })()`,
        false,
      ),
    ),
  );

  for (const wait of [3000, 5000, 8000, 15000]) {
    await sleep(wait === 3000 ? 3000 : wait - 3000 + 3000);
    console.log(`=== +${wait}ms ===`);
    console.log(
      JSON.stringify(
        await evalJs(
          `(() => {
          const overlay = document.querySelector("game-starting-modal");
          const dim = overlay && overlay.firstElementChild;
          const dimStyle = dim ? getComputedStyle(dim) : null;
          const menu = document.querySelector("single-player-modal");
          return {
            overlayVisible: overlay ? overlay.isVisible : null,
            overlayDisplay: dimStyle ? dimStyle.visibility + "/" + dimStyle.opacity : null,
            modalStarting: menu ? menu.starting : null,
            hasCanvas: !!document.querySelector("canvas"),
          };
        })()`,
          false,
        ),
      ),
    );
  }
}

await sleep(1000);
if (doGod) {
  // Still in the spawn phase here; pick a spawn tile first so the tests run in
  // a live game (the human has territory and the clock is running).
  console.log("=== spawning ===");
  await clickAt(660, 420);
  await sleep(2500);
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const g = document.querySelector('settings-modal')?.game;
        return g
          ? {
              alive: g.myPlayer()?.isAlive() ?? null,
              tiles: g.myPlayer()?.numTilesOwned?.() ?? null,
            }
          : { game: null };
      })()`,
        false,
      ),
    ),
  );

  console.log("=== right-click radial (god hub) ===");
  await rightClickAt(700, 400);
  await sleep(1200);
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const g = document.querySelector('settings-modal')?.game;
        const root = document.querySelector('.radial-menu-container');
        const texts = [...document.querySelectorAll(
          '.radial-menu-container text, .radial-menu-container div',
        )]
          .map((e) => (e.textContent || '').trim())
          .filter(Boolean);
        return {
          gameType: g?.config?.().gameConfig().gameType ?? null,
          radialVisible: root
            ? getComputedStyle(root).display !== 'none' &&
              getComputedStyle(root).visibility !== 'hidden'
            : false,
          hasGodHub: texts.includes('神'),
          nodeCount: texts.length,
        };
      })()`,
        false,
      ),
    ),
  );
  const godHubPoint = await evalJs(
    `(() => {
      const t = [...document.querySelectorAll('.radial-menu-container text')].find(
        (e) => (e.textContent || '').trim() === '神',
      );
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
    false,
  );
  console.log(`god hub point: ${JSON.stringify(godHubPoint?.value ?? null)}`);
  if (godHubPoint?.value) {
    await clickAt(godHubPoint.value.x, godHubPoint.value.y);
    await sleep(900);
    console.log(
      JSON.stringify(
        await evalJs(
          `(() => {
          const texts = [...document.querySelectorAll('.radial-menu-container text')]
            .map((e) => (e.textContent || '').trim())
            .filter(Boolean);
          return {
            hasLaws: texts.includes('法则'),
            hasPlayers: texts.includes('玩家'),
            hasTerrain: texts.includes('地形'),
            hasBuild: texts.includes('建造'),
            texts,
          };
        })()`,
          false,
        ),
      ),
    );
  }
  await evalJs(
    `(() => {
      const el = document.querySelector('.radial-menu-container');
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`,
    false,
  );
  await sleep(400);

  console.log("=== opening in-game menu ===");
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const img = document.querySelector('game-right-sidebar img[alt="settings"]');
        if (!img) return { found: false };
        (img.closest('.cursor-pointer') || img.parentElement).click();
        return { found: true };
      })()`,
        false,
      ),
    ),
  );
  await sleep(1500);
  console.log("=== god section ===");
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const m = document.querySelector('settings-modal');
        const txt = m ? m.textContent || '' : '';
        const rows = [...document.querySelectorAll('settings-modal button')]
          .map((b) => (b.textContent || '').trim())
          .filter((t) => /无限|上帝|核弹|瞬间|困难|金币|军队|消灭/.test(t));
        let game = null;
        try {
          game = m && m.game
            ? {
                players: m.game.players().length,
                withClient: m.game.players().filter((p) => p.clientID() !== null).length,
                myClient: m.game.myPlayer()?.clientID() ?? null,
                myGold: String(m.game.myPlayer()?.gold() ?? "0"),
                myAlive: m.game.myPlayer()?.isAlive() ?? null,
                myTiles: m.game.myPlayer()?.numTilesOwned() ?? null,
              }
            : null;
        } catch (e) {
          game = { error: String(e) };
        }
        return { open: m ? m.open : null, hasGodTitle: txt.includes('上帝模式'), rows, game };
      })()`,
        false,
      ),
    ),
  );
  console.log("=== toggling infinite gold + a player power ===");
  console.log(
    JSON.stringify(
      await evalJs(
        `(() => {
        const btns = [...document.querySelectorAll('settings-modal button')];
        const gold = btns.find((b) => (b.textContent || '').includes('无限金币'));
        if (gold) gold.click();
        const give = btns.find((b) => (b.textContent || '').trim() === '+金币');
        if (give) give.click();
        const kill = btns.find((b) => (b.textContent || '').trim() === '消灭');
        if (kill) kill.click();
        return { goldToggle: !!gold, giveGold: !!give, conquer: !!kill };
      })()`,
        false,
      ),
    ),
  );
  await sleep(800);

  const gameQuery = async (expr) => {
    const r = await evalJs(
      `(() => { const g = document.querySelector('settings-modal').game; return ${expr}; })()`,
      false,
    );
    return r.value;
  };
  const armBrush = (label) =>
    evalJs(
      `(() => {
        const btns = [...document.querySelectorAll('settings-modal button')];
        const b = btns.find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
        if (!b) return { found: false };
        b.click();
        const m = document.querySelector('settings-modal');
        return { found: true, armed: !!m?.uiState?.godBrush, open: m?.open };
      })()`,
      false,
    );
  const openMenu = () =>
    evalJs(
      `(() => {
        const img = document.querySelector('game-right-sidebar img[alt="settings"]');
        if (!img) return { found: false };
        (img.closest('.cursor-pointer') || img.parentElement).click();
        return { found: true };
      })()`,
      false,
    );
  const pressEsc = () =>
    evalJs(
      `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; })()`,
      false,
    );
  const readIndicator = () =>
    evalJs(
      `(() => {
        const ind = [...document.querySelectorAll('body > div')].find((d) =>
          (d.textContent || '').includes('上帝之笔'),
        );
        return { indicator: ind ? ind.textContent : null };
      })()`,
      false,
    );

  console.log("=== paint test: build City on the map ===");
  console.log(JSON.stringify(await armBrush("城市")));
  await sleep(400);
  console.log(JSON.stringify(await readIndicator()));
  const cityBefore = await gameQuery("g.units('City').length");
  await clickGrid();
  await sleep(1500);
  const cityAfter = await gameQuery("g.units('City').length");
  console.log(
    JSON.stringify({
      cityBefore,
      cityAfter,
      myGoldAfterInfinite: await gameQuery(
        "String(g.myPlayer()?.gold() ?? '0')",
      ),
    }),
  );
  await pressEsc();
  await sleep(300);

  console.log("=== paint test: sink tiles to water ===");
  console.log(JSON.stringify(await openMenu()));
  await sleep(1200);
  console.log(JSON.stringify(await armBrush("降为水面")));
  await sleep(400);
  console.log(JSON.stringify(await readIndicator()));
  const landBefore = await gameQuery("g.numLandTiles()");
  await clickGrid();
  await sleep(1500);
  const landAfter = await gameQuery("g.numLandTiles()");
  console.log(JSON.stringify({ landBefore, landAfter }));
  await pressEsc();
  await sleep(300);
  console.log(JSON.stringify(await readIndicator()));
}

try {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(".browser-smoke.png", Buffer.from(shot.data, "base64"));
  console.log("screenshot: .browser-smoke.png");
} catch (e) {
  console.log("screenshot failed:", e.message);
}
ws.close();
chrome.kill();
console.log(`\n=== ${lines.length} console lines ===`);
