// In-memory fixed-window rate limiter, keyed by ip or tenant.
'use strict';

class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.buckets = new Map();
  }

  allow(key) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now - b.start >= this.windowMs) {
      b = { start: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    if (this.buckets.size > 10000) this.buckets.clear();
    return b.count <= this.limit;
  }
}

module.exports = { RateLimiter };
