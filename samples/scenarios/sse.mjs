import { canonicalJson, hasAsciiControlCharacters } from "./determinism.mjs";
import { fixtureResponseHeaders } from "./http.mjs";

export function createSseSubscriber(req, res, { onClose, maximumQueuedEvents = 32 }) {
  if (!Number.isSafeInteger(maximumQueuedEvents) || maximumQueuedEvents < 1 || maximumQueuedEvents > 256) {
    throw new Error("SSE queue capacity must be between 1 and 256.");
  }
  res.writeHead(
    200,
    fixtureResponseHeaders(
      { connection: "keep-alive", contentType: "text/event-stream; charset=utf-8" },
      { "x-accel-buffering": "no" },
    ),
  );
  res.flushHeaders?.();
  let closed = false;
  let blocked = false;
  const queue = [];

  function safeEventType(value) {
    const type = value ?? "message";
    if (typeof type !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(type)) {
      throw new TypeError("SSE event type contains invalid framing characters.");
    }
    return type;
  }

  function safeEventId(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 256 || hasAsciiControlCharacters(value)) {
      throw new TypeError("SSE event id contains invalid framing characters.");
    }
    return value;
  }

  function encode(event) {
    const eventId = event?.eventId === undefined ? "" : `id: ${safeEventId(event.eventId)}\n`;
    return `event: ${safeEventType(event?.type)}\n${eventId}data: ${canonicalJson(event)}\n\n`;
  }

  function flush() {
    if (closed || blocked) return;
    while (queue.length > 0) {
      try {
        if (!res.write(queue.shift())) {
          blocked = true;
          return;
        }
      } catch {
        close("write-failed");
        return;
      }
    }
  }

  function close(reason = "closed") {
    if (closed) return;
    closed = true;
    queue.length = 0;
    res.off("drain", onDrain);
    req.off("close", onSocketClose);
    res.off("close", onSocketClose);
    try {
      if (!res.writableEnded) res.end();
    } catch {
      // The peer can disappear between writableEnded and end().
    }
    try {
      onClose?.(reason);
    } catch {
      // Cleanup callbacks must not escape the stream boundary.
    }
  }

  function onDrain() {
    blocked = false;
    flush();
  }

  function onSocketClose() {
    close("peer-closed");
  }

  res.on("drain", onDrain);
  req.on("close", onSocketClose);
  res.on("close", onSocketClose);

  return Object.freeze({
    send(event) {
      if (closed) return false;
      if (queue.length >= maximumQueuedEvents) {
        close("queue-capacity");
        return false;
      }
      try {
        queue.push(encode(event));
      } catch {
        close("encode-failed");
        return false;
      }
      flush();
      return !closed;
    },
    close,
    isClosed: () => closed,
    queuedEventCount: () => queue.length,
  });
}
