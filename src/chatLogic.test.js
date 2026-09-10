import { test } from "node:test";
import assert from "node:assert/strict";
import { HISTORY_LIMIT, createMessage, getHistory, pushMessage } from "./chatLogic.js";

// Minimal in-memory stand-in for the redis v4 client, implementing just
// enough list semantics (rPush/lTrim/lRange with negative indices, same as
// real Redis) to exercise pushMessage/getHistory's actual cap behavior
// without a live Redis connection.
function makeFakeRedis() {
  const store = new Map();

  function resolveRange(len, start, stop) {
    let s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    let e = stop < 0 ? len + stop : Math.min(stop, len - 1);
    if (e < s) return [0, -1]; // empty
    return [s, e];
  }

  return {
    _raw(key) {
      return store.get(key) || [];
    },
    async rPush(key, val) {
      const arr = store.get(key) || [];
      arr.push(val);
      store.set(key, arr);
      return arr.length;
    },
    async lTrim(key, start, stop) {
      const arr = store.get(key) || [];
      const [s, e] = resolveRange(arr.length, start, stop);
      store.set(key, e < s ? [] : arr.slice(s, e + 1));
    },
    async lRange(key, start, stop) {
      const arr = store.get(key) || [];
      const [s, e] = resolveRange(arr.length, start, stop);
      return e < s ? [] : arr.slice(s, e + 1);
    },
  };
}

test("createMessage defaults name to Anonymous when falsy", () => {
  assert.equal(createMessage(undefined, "hi", 123).name, "Anonymous");
  assert.equal(createMessage("", "hi", 123).name, "Anonymous");
  assert.equal(createMessage(null, "hi", 123).name, "Anonymous");
});

test("createMessage keeps a real name and the given text/ts", () => {
  const msg = createMessage("Alice", "hello", 999);
  assert.deepEqual(msg, { name: "Alice", text: "hello", ts: 999 });
});

test("createMessage defaults ts to Date.now() when omitted", () => {
  const before = Date.now();
  const msg = createMessage("Alice", "hi");
  const after = Date.now();
  assert.ok(msg.ts >= before && msg.ts <= after);
});

test("pushMessage + getHistory round-trip a handful of messages in order", async () => {
  const redis = makeFakeRedis();
  const roomId = "room-1";
  const messages = [
    createMessage("Alice", "hi", 1),
    createMessage("Bob", "hello", 2),
    createMessage("Alice", "how are you", 3),
  ];
  for (const m of messages) await pushMessage(redis, roomId, m);

  const history = await getHistory(redis, roomId);
  assert.deepEqual(history, messages);
});

test("history is capped at HISTORY_LIMIT (50) messages, keeping the most recent", async () => {
  const redis = makeFakeRedis();
  const roomId = "room-cap";
  const total = HISTORY_LIMIT + 10; // 60 messages

  for (let i = 0; i < total; i++) {
    await pushMessage(redis, roomId, createMessage("Alice", `msg-${i}`, i));
  }

  // Underlying redis list itself must be trimmed, not just the read side.
  assert.equal(redis._raw(`chat:${roomId}`).length, HISTORY_LIMIT);

  const history = await getHistory(redis, roomId);
  assert.equal(history.length, HISTORY_LIMIT);
  // Oldest surviving message is msg-10 (the first 10 were trimmed off),
  // newest is msg-59 (the last one pushed), and order is preserved.
  assert.equal(history[0].text, `msg-${total - HISTORY_LIMIT}`);
  assert.equal(history[history.length - 1].text, `msg-${total - 1}`);
});

test("history caps correctly even when messages arrive one at a time across the boundary", async () => {
  const redis = makeFakeRedis();
  const roomId = "room-boundary";

  // Push exactly HISTORY_LIMIT messages: nothing should be trimmed yet.
  for (let i = 0; i < HISTORY_LIMIT; i++) {
    await pushMessage(redis, roomId, createMessage("Alice", `msg-${i}`, i));
  }
  assert.equal((await getHistory(redis, roomId)).length, HISTORY_LIMIT);

  // One more push should evict exactly the oldest message.
  await pushMessage(redis, roomId, createMessage("Alice", "msg-overflow", HISTORY_LIMIT));
  const history = await getHistory(redis, roomId);
  assert.equal(history.length, HISTORY_LIMIT);
  assert.equal(history[0].text, "msg-1");
  assert.equal(history[history.length - 1].text, "msg-overflow");
});

test("getHistory returns an empty array for a room with no messages", async () => {
  const redis = makeFakeRedis();
  assert.deepEqual(await getHistory(redis, "empty-room"), []);
});
