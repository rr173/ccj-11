// 进程内滑动窗口限流。本服务为单进程 + SQLite 部署；多副本部署时可替换为共享存储实现。
// 核验接口只对“失败尝试”计数：成功核验不消耗配额。
const buckets = new Map();

function getBucket(key) {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = [];
    buckets.set(key, bucket);
  }
  return bucket;
}

// 只检查是否已超限，不记录本次尝试
export function peekRateLimit(key, { windowMs, max, now = Date.now() }) {
  const bucket = getBucket(key);
  const cutoff = now - windowMs;
  while (bucket.length > 0 && bucket[0] <= cutoff) bucket.shift();
  if (bucket.length >= max) {
    return { allowed: false, remaining: 0, retryAfterMs: bucket[0] + windowMs - now };
  }
  return { allowed: true, remaining: max - bucket.length, retryAfterMs: 0 };
}

// 记录一次失败尝试
export function recordFailure(key, { windowMs, now = Date.now() }) {
  getBucket(key).push(now);
}

export function resetRateLimits() {
  buckets.clear();
}

// 定期清理过期桶，避免长期运行后内存增长
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    while (bucket.length > 0 && bucket[0] <= now - 60 * 60 * 1000) bucket.shift();
    if (bucket.length === 0) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();
