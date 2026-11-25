// ---------------------------------------------------------------------------
// A RATE LIMIT FOR A PUBLIC, TOKEN-SCOPED ROUTE (client self-onboarding, owner 2026-11-10).
//
// A no-login page whose token is the only gate can be probed: a stranger guessing tokens, or a
// script hammering a real link's write routes. The token is 256 random bits, so guessing is hopeless,
// but nothing should be free to try a million times either. Two windows per caller (req.ip, which is
// the client behind the documented proxy: server.ts sets "trust proxy"):
//   · every request: `max` per `windowMs` (generous: a person filling in a form never gets near it);
//   · refused tokens (a 404 answer): `maxMisses` per `windowMs`, after which every request from that
//     caller is refused for the rest of the window, valid token or not.
// In-memory, per process, like the login lockout and the review quota: a restart resets it, which is
// fine for a brake. A 429 says only "try again later" — never whether a token exists.
// ---------------------------------------------------------------------------
import type { NextFunction, Request, Response } from "express";

export interface PublicRateLimitOptions { windowMs: number; max: number; maxMisses: number; now?: () => number }

interface Bucket { start: number; hits: number; misses: number }

export function publicRateLimit(opts: PublicRateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  const now = opts.now ?? (() => Date.now());
  const bucketFor = (key: string): Bucket => {
    const t = now();
    let b = buckets.get(key);
    if (!b || t - b.start >= opts.windowMs) {
      b = { start: t, hits: 0, misses: 0 };
      buckets.set(key, b);
      // Keep the map bounded: drop windows that have closed.
      if (buckets.size > 10_000) for (const [k, v] of buckets) if (t - v.start >= opts.windowMs) buckets.delete(k);
    }
    return b;
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = String(req.ip || req.socket?.remoteAddress || "unknown");
    const b = bucketFor(key);
    b.hits++;
    if (b.hits > opts.max || b.misses >= opts.maxMisses) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((opts.windowMs - (now() - b.start)) / 1000))));
      res.status(429).json({ error: "Too many requests from here. Wait a few minutes and try again." });
      return;
    }
    res.on("finish", () => { if (res.statusCode === 404) b.misses++; });
    next();
  };
}
