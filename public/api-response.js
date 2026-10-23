export class ApiResponseError extends Error {
  constructor(message, status, retryAfterMs = 0) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryDelay(response, now) {
  const value = response.headers.get("Retry-After");
  if (!value) return 60_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(1000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(1000, date - now) : 60_000;
}

export async function readApiResponse(response, now = Date.now()) {
  const body = await response.text();
  let result;
  try {
    result = JSON.parse(body);
  } catch {
    const quota =
      response.status === 429 && /1027/.test(body) && /Cloudflare/i.test(body);
    if (quota) {
      const nextUtcDay = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
      const justReset = now % 86_400_000 < 120_000;
      throw new ApiResponseError(
        justReset
          ? "服务仍暂时受限，请一分钟后再试。"
          : "今日服务请求额度已用完，将在北京时间 08:00 重置。请稍后再试。",
        429,
        justReset ? 60_000 : nextUtcDay - now,
      );
    }
    if (response.status === 429)
      throw new ApiResponseError(
        "请求暂时受限（HTTP 429），请稍后再试。",
        429,
        retryDelay(response, now),
      );
    throw new ApiResponseError(
      `服务暂时返回了非预期响应（HTTP ${response.status}），请稍后重试。`,
      response.status,
    );
  }
  if (!response.ok)
    throw new ApiResponseError(
      typeof result?.error === "string"
        ? result.error
        : `请求失败（HTTP ${response.status}）`,
      response.status,
      response.status === 429 ? retryDelay(response, now) : 0,
    );
  return result;
}
