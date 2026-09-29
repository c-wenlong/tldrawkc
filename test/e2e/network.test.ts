/**
 * The page has no network (D46).
 *
 * A snippet runs with the page's full power, and it is written by an agent that
 * may be reading untrusted text, so anything the page can reach, that agent can
 * reach: a `fetch` to any host would carry out whatever the agent could read,
 * pull a web page back into its context, or poke a service on the machine's
 * own loopback. Before D46 every one of the probes below arrived at the
 * listener this file starts.
 *
 * The listener is a loopback HTTP server that also takes WebSocket upgrades,
 * plus a UDP socket for WebRTC's STUN. It is not the page server: that one is
 * the page's own origin and is meant to answer. The assertion that matters in
 * every test is that the listener heard nothing.
 *
 * The block is three layers, and each is pinned on its own as well as
 * together, because each one is the only layer somewhere: the switches are
 * the floor under everything, the interception is what stops a navigation,
 * and the CSP header is all serve mode has, since serve opens the human's own
 * browser rather than one this process launched.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { chromium, type Browser } from "playwright-core";

import {
  isolationArgs,
  newIsolatedContext,
  resolveChromium,
  withCanvas,
  withRasterPage,
} from "../../src/lib/browser.js";
import { PAGE_INDEX_HTML } from "../../src/lib/paths.js";
import { startPageServer, type PageServer } from "../../src/lib/server.js";
import { verify } from "../../src/lib/verify.js";

/** What the listener heard, in arrival order. */
let heard: string[] = [];
let target: http.Server;
let udp: dgram.Socket;
let httpPort: number;
let udpPort: number;
let executablePath: string;

beforeAll(async () => {
  const built = await fs.stat(PAGE_INDEX_HTML).catch(() => null);
  if (!built) throw new Error(`${PAGE_INDEX_HTML} is missing. Run \`npm run build\` first.`);
  executablePath = (await resolveChromium()).executablePath;

  target = http.createServer((request, response) => {
    heard.push(`${request.method ?? "?"} ${request.url ?? "?"}`);
    // CORS open on purpose: a probe that fails must fail because it never
    // arrived, not because the answer could not be read.
    response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" });
    response.end("a secret the page must never read");
  });
  target.on("upgrade", (request, socket) => {
    heard.push(`UPGRADE ${request.url ?? "?"}`);
    socket.destroy();
  });
  await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  httpPort = (target.address() as AddressInfo).port;

  udp = dgram.createSocket("udp4");
  udp.on("message", (message) => heard.push(`UDP ${String(message.length)} bytes`));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  udpPort = udp.address().port;
});

afterAll(async () => {
  target.closeAllConnections();
  await new Promise<void>((resolve) => target.close(() => resolve()));
  await new Promise<void>((resolve) => udp.close(() => resolve()));
});

beforeEach(() => {
  heard = [];
});

/**
 * Every way out a page has, each caught so one failure cannot hide the rest.
 *
 * Returned as source so it can go through `exec` on the real canvas and
 * through `evaluate` on a bare page alike. The trailing wait gives the
 * fire-and-forget probes (the image, the beacon, the prefetch, the popup,
 * WebRTC's STUN) time to arrive before anyone looks.
 */
function probeSource(): string {
  const at = `http://127.0.0.1:${String(httpPort)}`;
  return `
    const at = ${JSON.stringify(at)};
    const out = {};
    const settle = (setup) => new Promise((resolve) => {
      setTimeout(() => resolve("timeout"), 1500);
      try { setup(resolve); } catch (error) { resolve("threw " + error.message); }
    });
    try { out.fetchLoopback = await (await fetch(at + "/fetch")).text(); }
    catch (error) { out.fetchLoopback = "rejected"; }
    try { out.fetchNoCors = (await fetch(at + "/fetch-no-cors", { mode: "no-cors" })).type; }
    catch (error) { out.fetchNoCors = "rejected"; }
    try { out.fetchExternal = (await fetch("https://example.com/?d=probe", { mode: "no-cors" })).type; }
    catch (error) { out.fetchExternal = "rejected"; }
    out.xhr = await settle((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.onload = () => resolve("loaded");
      xhr.onerror = () => resolve("error");
      xhr.open("GET", at + "/xhr");
      xhr.send();
    });
    out.image = await settle((resolve) => {
      const image = new Image();
      image.onload = () => resolve("loaded");
      image.onerror = () => resolve("error");
      image.src = at + "/image.png";
    });
    try { out.beacon = navigator.sendBeacon(at + "/beacon", "payload"); }
    catch (error) { out.beacon = "threw"; }
    out.webSocket = await settle((resolve) => {
      const socket = new WebSocket("ws://127.0.0.1:${String(httpPort)}/socket");
      socket.onopen = () => resolve("open");
      socket.onerror = () => resolve("error");
      socket.onclose = (event) => resolve("closed " + String(event.code));
    });
    out.eventSource = await settle((resolve) => {
      const source = new EventSource(at + "/events");
      source.onopen = () => resolve("open");
      source.onerror = () => { source.close(); resolve("error"); };
    });
    const prefetch = document.createElement("link");
    prefetch.rel = "prefetch";
    prefetch.href = at + "/prefetch";
    document.head.appendChild(prefetch);
    const frame = document.createElement("iframe");
    frame.src = at + "/iframe";
    document.body.appendChild(frame);
    const style = document.createElement("style");
    style.textContent = "@font-face{font-family:probe;src:url(" + at + "/font.woff2)}" +
      "body{font-family:probe;background-image:url(" + at + "/background.png)}";
    document.head.appendChild(style);
    out.worker = await settle((resolve) => {
      const code = "fetch(" + JSON.stringify(at + "/worker") + ", { mode: 'no-cors' })" +
        ".then(() => postMessage('reached'), () => postMessage('rejected'))";
      const worker = new Worker(URL.createObjectURL(new Blob([code], { type: "text/javascript" })));
      worker.onmessage = (event) => resolve(event.data);
      worker.onerror = () => resolve("refused");
    });
    try {
      const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${String(udpPort)}" }] });
      peer.createDataChannel("probe");
      await peer.setLocalDescription(await peer.createOffer());
      out.webrtc = "gathering";
    } catch (error) { out.webrtc = "threw"; }
    try { out.popup = window.open(at + "/popup") ? "opened" : "refused"; }
    catch (error) { out.popup = "threw"; }
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return out;
  `;
}

/** The probe as an expression a bare page can `evaluate`. */
function probeExpression(): string {
  return `(async () => {${probeSource()}})()`;
}

/** What the page itself saw, for the probes whose outcome it can observe. */
function expectRefusedInPage(result: Record<string, unknown>): void {
  expect(result.fetchLoopback).toBe("rejected");
  expect(result.fetchNoCors).toBe("rejected");
  // Before D46 this came back `opaque`: the request left for example.com.
  expect(result.fetchExternal).toBe("rejected");
  expect(result.xhr).toBe("error");
  expect(result.image).toBe("error");
  // "error" when CSP refused it, "closed 1008" when the interception did.
  expect(result.webSocket).not.toBe("open");
  expect(result.webSocket).not.toBe("timeout");
  expect(result.eventSource).toBe("error");
  expect(result.worker).not.toBe("reached");
}

describe("the canvas, as a snippet sees it", () => {
  it("reaches nothing but its own origin, and every attempt is on the record", async () => {
    const answer = await withCanvas({}, async (canvas) => {
      const ran = await canvas.exec(probeSource());
      return { result: ran.result as Record<string, unknown>, offHost: canvas.offHostRequests() };
    });

    expect(heard).toEqual([]);
    expectRefusedInPage(answer.result);
    // `doctor`'s audit still sees what was blocked, including the fetches the
    // CSP refused before they became requests at all.
    const origin = `http://127.0.0.1:${String(httpPort)}`;
    expect(answer.offHost).toContain(`${origin}/fetch`);
    expect(answer.offHost).toContain("https://example.com/?d=probe");
    expect(answer.offHost).toContain(`${origin}/image.png`);
  });

  it("still loads its own bundle, fonts included", async () => {
    const families = await withCanvas({}, async (canvas) => {
      const loaded = await canvas.fontsReady();
      expect(canvas.failedRequests()).toEqual([]);
      expect(canvas.offHostRequests()).toEqual([]);
      return loaded;
    });
    expect(families).toContain("tldraw_draw");
  });
});

describe("verify's harness, which carries no CSP", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-net-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("is kept offline by the interception and the switches alone", async () => {
    await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>harness</title>");
    const result = await withRasterPage({ root: dir }, (page) =>
      page.evaluate<Record<string, unknown>>(probeExpression()),
    );
    expect(heard).toEqual([]);
    expectRefusedInPage(result);
  });

  it("still reports an SVG that reaches out, without letting the request leave", async () => {
    // The reason the harness has no CSP: a request CSP refuses never raises
    // `request`, and `self-contained` would pass this file.
    const svg = path.join(dir, "reaches-out.svg");
    await fs.writeFile(
      svg,
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
        `width="100" height="40" viewBox="0 0 100 40">` +
        `<image href="http://127.0.0.1:${String(httpPort)}/linked.png" width="10" height="10"/>` +
        `<text x="10" y="30" font-family="sans-serif">label</text></svg>`,
    );
    const result = await verify({ file: svg, output: path.join(dir, "out.png"), cwd: dir });
    const selfContained = result.checks.find((check) => check.rule === "self-contained");
    expect(selfContained?.ok).toBe(false);
    expect(selfContained?.detail).toContain("linked.png");
    expect(heard).toEqual([]);
  });
});

describe("each layer on its own", () => {
  let dir: string;
  let server: PageServer;
  let browser: Browser | undefined;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "tldrawkc-net-layer-"));
    await fs.writeFile(path.join(dir, "index.html"), "<!doctype html><title>layer</title>");
  });

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("the probe is real: with no layer at all, the listener hears it", async () => {
    // Without this, every "heard nothing" below could be a probe that never
    // fired. It is also the before picture D46 records.
    server = await startPageServer({ root: dir, contentSecurityPolicy: null });
    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.evaluate(probeExpression());
    expect(heard).toContain("GET /fetch");
    expect(heard).toContain("POST /beacon");
    expect(heard).toContain("UPGRADE /socket");
    expect(heard.some((line) => line.startsWith("UDP "))).toBe(true);
  });

  it("the switches alone stop everything, WebRTC's UDP included", async () => {
    server = await startPageServer({ root: dir, contentSecurityPolicy: null });
    browser = await chromium.launch({ executablePath, args: isolationArgs(server.url) });
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.evaluate(probeExpression());
    expect(heard).toEqual([]);
  });

  it("the interception alone stops every request and socket, though not WebRTC", async () => {
    server = await startPageServer({ root: dir, contentSecurityPolicy: null });
    browser = await chromium.launch({ executablePath });
    const context = await newIsolatedContext(browser, server.url);
    const page = await context.newPage();
    await page.goto(server.url);
    await page.evaluate(probeExpression());
    // STUN is UDP from the network service and never a request; that is the
    // switches' job, pinned above.
    expect(heard.filter((line) => !line.startsWith("UDP "))).toEqual([]);
  });

  it("the CSP alone, which is all serve mode has, stops every fetch, socket and subresource", async () => {
    // A plain browser standing in for the human's own, as serve opens it.
    server = await startPageServer({ root: dir });
    browser = await chromium.launch({ executablePath });
    const page = await browser.newPage();
    await page.goto(server.url);
    await page.evaluate(probeExpression());
    // A navigation (the popup) and WebRTC are outside what CSP can refuse.
    // In serve mode no snippet runs, so what CSP is guarding against there is
    // a document whose shapes point at a remote URL, which is a subresource.
    expect(heard.filter((line) => line !== "GET /popup" && line !== "GET /favicon.ico" && !line.startsWith("UDP "))).toEqual([]);
  });
});
