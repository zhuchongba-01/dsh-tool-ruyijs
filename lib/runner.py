"""ruyijs daemon: one persistent Context, JSON lines in / JSON lines out.

Node side owns lifecycle (spawn on demand, idle kill). This side only serves ops.
"""
import json
import math
import sys
import time

from ruyijs import Context, JSError

_ctx = None


def out(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def ensure(msg):
    global _ctx
    if _ctx is not None:
        return _ctx
    ctx = Context(proxy=msg.get("proxy") or None, timeout=int(msg.get("timeout") or 30))
    fingerprint = msg.get("fingerprint")
    if isinstance(fingerprint, dict) and fingerprint:
        ctx.configure_fingerprint(fingerprint)
    clock = msg.get("clock")
    if isinstance(clock, dict) and clock.get("mode"):
        ctx.configure_clock(clock["mode"], epoch_ms=clock.get("epochMs"))
    _ctx = ctx
    return ctx


def plain(value):
    """JSON-safe projection of a JS value (no NaN/-0, no live handles)."""
    if value is None or isinstance(value, bool) or isinstance(value, str):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return repr(value)
        return 0 if value == 0 else value
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    return repr(value)


def probe(ctx, expected_url=None):
    """One RPC answers commit, parse and URL together.

    Three separate `eval` calls per check were themselves the reason settling timed out:
    every call is a full named-pipe round trip, so a fixed step count expired long before
    the page could commit.
    """
    try:
        state = ctx.eval(
            "JSON.stringify([document.readyState, String(location.href), !!document.body])",
            to_py=True,
        )
        ready, here, parsed = json.loads(state)
    except Exception:
        return False
    if ready != "complete" or not parsed:
        return False
    return expected_url is None or same_url(here, expected_url)


def same_url(here, expected):
    """Compare URLs across the trailing-slash normalization browsers apply.

    `new URL("https://a.b").href` is "https://a.b/", so a plain string compare never
    matches and every navigation looked like a failure.
    """
    return here == expected or here == expected + "/"


def settle(ctx, expected_url=None, budget_ms=20000, step_ms=25):
    """Advance the event loop until the target document is committed, parsed and URL-matched.

    The budget is wall-clock, not a step count: probes are RPCs, so their cost is latency,
    not iterations. The three traps still guarded here:
    * `document.readyState` can read "complete" on the *previous* (blank) document before the
      navigation commits, so the probe also compares `location.href`.
    * A committed but not-yet-parsed document reports "complete" with an empty body, so the
      probe requires the body to have element children.
    """
    deadline = time.monotonic() + budget_ms / 1000
    while True:
        if probe(ctx, expected_url):
            return True
        if time.monotonic() >= deadline:
            return False
        ctx.advance(step_ms)


def load(ctx, url):
    """Navigate and settle once: a retry would double a wait that is already tens of seconds."""
    ctx.navigate(url)
    if settle(ctx, url):
        return {"ok": True, "attempts": 1}
    return {"ok": False, "empty": True, "error": "navigation produced an empty document; the page may need load_page"}


def handle(msg):
    op = msg.get("op")
    if op == "ping":
        return {"ok": True, "pong": True}
    if op == "navigate":
        return load(ensure(msg), msg["url"])
    if op == "load_page":
        ctx = ensure(msg)
        ctx.load_page(msg["url"], msg.get("html", ""))
        settle(ctx)
        return {"ok": True}
    if op == "eval":
        ctx = ensure(msg)
        value = ctx.eval(msg["js"], filename="tool.js", to_py=True)
        return {"ok": True, "value": plain(value)}
    if op == "advance":
        ensure(msg).advance(int(msg.get("ms") or 0))
        return {"ok": True}
    if op == "read":
        return {"ok": True, "value": plain(ensure(msg).eval(msg["js"], filename="read.js", to_py=True))}
    if op == "logs":
        ctx = ensure(msg)
        return {"ok": True, "net": plain(ctx.net_log()), "console": plain(ctx.console_log())}
    if op == "close":
        global _ctx
        if _ctx is not None:
            _ctx.close()
            _ctx = None
        return {"ok": True}
    return {"ok": False, "error": "unknown op: %r" % (op,)}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception as error:
            out({"ok": False, "error": "bad json: %s" % error})
            continue
        try:
            result = handle(msg)
        except JSError as error:
            result = {"ok": False, "error": error.message, "name": error.name,
                      "stack": (error.stack or "")[:4000]}
        except Exception as error:
            result = {"ok": False, "error": "%s: %s" % (type(error).__name__, error)}
        result.setdefault("ok", True)
        out(result)


if __name__ == "__main__":
    main()
