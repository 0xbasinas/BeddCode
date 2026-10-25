var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.ts
import { DurableObject } from "cloudflare:workers";

// ../src/protocol.ts
var CLOSE = {
  badRequest: 4400,
  unauthorized: 4401,
  hostOffline: 4404,
  roomFull: 4429,
  replaced: 4409
};
var MAX_CLIENTS_PER_ROOM = 8;
var MAX_FRAME_CHARS = 128 * 1024;
var CLAIM_TIMEOUT_MS = 1e4;
var ROOM = /^[A-Za-z0-9_-]{16,64}$/;
var B64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
var CID = /^[0-9a-f]{8,32}$/;
var validRoom = /* @__PURE__ */ __name((room) => !!room && ROOM.test(room), "validRoom");
function parse(text) {
  if (text.length > MAX_FRAME_CHARS) return null;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
__name(parse, "parse");
var str = /* @__PURE__ */ __name((v, max = MAX_FRAME_CHARS) => typeof v === "string" && v.length <= max && B64.test(v), "str");
function parseClientFrame(text) {
  const f = parse(text);
  if (!f) return null;
  if (f.t === "hi" && str(f.n, 64)) return { t: "hi", n: f.n };
  if (f.t === "m" && str(f.d) && (f.f === void 0 || typeof f.f === "boolean"))
    return { t: "m", d: f.d, f: f.f };
  return null;
}
__name(parseClientFrame, "parseClientFrame");
function parseHostFrame(text) {
  const f = parse(text);
  if (!f) return null;
  if (f.t === "host" && str(f.auth, 128)) return { t: "host", auth: f.auth };
  if (typeof f.c !== "string" || !CID.test(f.c)) return null;
  if (f.t === "close") return { t: "close", c: f.c };
  if (f.t === "hi" && str(f.n, 64)) return { t: "hi", c: f.c, n: f.n };
  if (f.t === "m" && str(f.d) && (f.f === void 0 || typeof f.f === "boolean"))
    return { t: "m", c: f.c, d: f.d, f: f.f };
  return null;
}
__name(parseHostFrame, "parseHostFrame");
function sameSecret(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
__name(sameSecret, "sameSecret");
function newClientId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(newClientId, "newClientId");
function route(pathname) {
  const [, role, room, ...rest] = pathname.split("/");
  if (rest.length > 0 || role !== "host" && role !== "client" || !validRoom(room)) return null;
  return { role, room };
}
__name(route, "route");

// worker.ts
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    const target = route(url.pathname);
    if (!target || request.headers.get("Upgrade") !== "websocket")
      return new Response("Not found", { status: 404 });
    return env.ROOMS.get(env.ROOMS.idFromName(target.room)).fetch(request);
  }
};
var Room = class extends DurableObject {
  static {
    __name(this, "Room");
  }
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  claimedHost() {
    return this.ctx.getWebSockets("host").find((ws) => ws.deserializeAttachment()?.claimed);
  }
  async fetch(request) {
    const target = route(new URL(request.url).pathname);
    if (!target) return new Response("Not found", { status: 404 });
    if (target.role === "client") {
      if (!this.claimedHost()) return new Response("host offline", { status: 503 });
      if (this.ctx.getWebSockets("client").length >= MAX_CLIENTS_PER_ROOM)
        return new Response("room full", { status: 429 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    if (target.role === "host") {
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ claimed: false, at: Date.now() });
      await this.ctx.storage.setAlarm(Date.now() + CLAIM_TIMEOUT_MS);
    } else {
      const cid = newClientId();
      this.ctx.acceptWebSocket(server, ["client", `c:${cid}`]);
      this.claimedHost()?.send(JSON.stringify({ t: "open", c: cid }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }
  async alarm() {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets("host")) {
      const state = ws.deserializeAttachment();
      if (!state?.claimed && now - (state?.at ?? 0) >= CLAIM_TIMEOUT_MS)
        ws.close(CLOSE.unauthorized, "claim");
    }
  }
  async webSocketMessage(ws, message) {
    if (typeof message !== "string") return ws.close(CLOSE.badRequest, "text only");
    const tags = this.ctx.getTags(ws);
    if (tags.includes("host")) await this.fromHost(ws, message);
    else if (tags.includes("client")) this.fromClient(ws, tags, message);
  }
  async fromHost(ws, text) {
    const frame = parseHostFrame(text);
    if (!frame) return ws.close(CLOSE.badRequest, "bad frame");
    const state = ws.deserializeAttachment();
    if (!state?.claimed) {
      if (frame.t !== "host") return ws.close(CLOSE.badRequest, "claim first");
      const known = await this.ctx.storage.get("auth");
      if (known !== void 0 && !sameSecret(known, frame.auth))
        return ws.close(CLOSE.unauthorized, "room belongs to another host");
      if (known === void 0) await this.ctx.storage.put("auth", frame.auth);
      for (const other of this.ctx.getWebSockets("host"))
        if (other !== ws && other.deserializeAttachment()?.claimed)
          other.close(CLOSE.replaced, "replaced");
      ws.serializeAttachment({ claimed: true, at: Date.now() });
      return ws.send(JSON.stringify({ t: "ready" }));
    }
    if (frame.t === "host") return;
    const device = this.ctx.getWebSockets(`c:${frame.c}`)[0];
    if (!device) return;
    if (frame.t === "close") return device.close(1e3, "closed by host");
    device.send(
      JSON.stringify(frame.t === "hi" ? { t: "hi", n: frame.n } : { t: "m", d: frame.d, f: frame.f })
    );
  }
  fromClient(ws, tags, text) {
    const frame = parseClientFrame(text);
    if (!frame) return ws.close(CLOSE.badRequest, "bad frame");
    const cid = tags.find((t) => t.startsWith("c:"))?.slice(2);
    const host = this.claimedHost();
    if (!cid || !host) return ws.close(CLOSE.hostOffline, "host offline");
    host.send(JSON.stringify({ ...frame, c: cid }));
  }
  async webSocketClose(ws, code, reason) {
    try {
      ws.close(code >= 1e3 && code < 1004 ? code : 1e3, reason.slice(0, 100));
    } catch {
    }
    const tags = this.ctx.getTags(ws);
    if (tags.includes("host")) {
      const stillThere = this.ctx.getWebSockets("host").some((h) => h !== ws && h.deserializeAttachment()?.claimed);
      if (!stillThere)
        for (const device of this.ctx.getWebSockets("client"))
          device.close(CLOSE.hostOffline, "host offline");
    } else if (tags.includes("client")) {
      const cid = tags.find((t) => t.startsWith("c:"))?.slice(2);
      this.claimedHost()?.send(JSON.stringify({ t: "close", c: cid }));
    }
  }
  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011, "error");
  }
};

// ../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-o11WKw/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// ../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-o11WKw/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  Room,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
