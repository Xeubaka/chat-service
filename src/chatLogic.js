// Pure-ish chat logic, extracted from index.js so it can be unit tested
// without a live Redis connection or socket.io server (same pattern used
// in services/game-service/src/gameLogic.js). Callers inject a redis-like
// client exposing rPush/lTrim/lRange (the redis v4 client's own API shape).

export const HISTORY_LIMIT = 50;

export function createMessage(name, text, ts = Date.now()) {
  return { name: name || "Anonymous", text, ts };
}

export async function getHistory(redis, roomId, limit = HISTORY_LIMIT) {
  const history = await redis.lRange(`chat:${roomId}`, -limit, -1);
  return history.map((m) => JSON.parse(m));
}

export async function pushMessage(redis, roomId, message, limit = HISTORY_LIMIT) {
  await redis.rPush(`chat:${roomId}`, JSON.stringify(message));
  await redis.lTrim(`chat:${roomId}`, -limit, -1);
}
