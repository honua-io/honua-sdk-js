import { canonicalJson, hasAsciiControlCharacters } from "../determinism.mjs";
import { fixtureHeaders, fixtureResponseHeaders, sendJson, sendText } from "../http.mjs";
import { createSseSubscriber } from "../sse.mjs";

const STREAM_PATH = "/api/v1/streaming/features";
const CAPABILITIES_PATH = `${STREAM_PATH}/capabilities`;
const SAFE_EDIT_ID = "DEMO-EDIT-0001";
const MAXIMUM_IDEMPOTENCY_KEYS = 128;

function clone(value) {
  return structuredClone(value);
}

function cursor(run, sequence) {
  return `rt:${run.id}:${sequence}:${run.state.cursorGeneration}`;
}

function patch(run, incident) {
  return {
    sourceId: run.state.sourceId,
    id: incident.id,
    feature: clone(incident),
    updatedAt: incident.updatedAt,
  };
}

function nextSequence(run) {
  run.state.sequence += 1;
  return run.state.sequence;
}

function snapshotEvent(run, { replace = true, features } = {}) {
  const sequence = nextSequence(run);
  const selected = features ?? [...run.state.features.values()];
  return {
    type: "snapshot",
    eventId: `snapshot-${run.id}-${sequence}`,
    cursor: cursor(run, sequence),
    watermark: run.clock.iso(),
    timestamp: run.clock.iso(),
    sequence,
    receivedAt: run.clock.now(),
    features: selected.map((feature) => patch(run, feature)),
    replace,
  };
}

function rememberBounded(set, value) {
  set.add(value);
  if (set.size > 128) set.delete(set.values().next().value);
}

function rememberRealtimeIdentity(run, event) {
  if (event.eventId) rememberBounded(run.state.issuedEventIds, event.eventId);
  if (typeof event.cursor !== "string") return;
  const [kind, cursorRun, sequenceText, generation] = event.cursor.split(":");
  const sequence = Number(sequenceText);
  if (
    kind === "rt" &&
    cursorRun === run.id &&
    generation === run.state.cursorGeneration &&
    /^(0|[1-9]\d*)$/.test(sequenceText ?? "") &&
    Number.isSafeInteger(sequence) &&
    sequence <= run.state.sequence
  ) {
    rememberBounded(run.state.issuedRealtimeCursors, event.cursor);
  }
}

function broadcast(run, event, remember = false) {
  if (remember) run.state.lastDataEvent = clone(event);
  rememberRealtimeIdentity(run, event);
  for (const subscriber of [...run.state.subscribers]) {
    if (!subscriber.send(event)) run.state.subscribers.delete(subscriber);
  }
}

function statusEvent(run, status, extras = {}) {
  return { type: "status", status, receivedAt: run.clock.now(), ...extras };
}

function heartbeatEvent(run) {
  const sequence = nextSequence(run);
  return {
    type: "heartbeat",
    eventId: `heartbeat-${run.id}-${sequence}`,
    cursor: cursor(run, sequence),
    receivedAt: run.clock.now(),
  };
}

function resolveStreamFeatures(run, url) {
  const all = [...run.state.features.values()];
  const hasPageCursor = url.searchParams.has("pageCursor");
  if (url.searchParams.getAll("pageCursor").length > 1) {
    throw Object.assign(new Error("pageCursor may appear only once."), { status: 400 });
  }
  if (run.scenario !== "paginated" && hasPageCursor) {
    throw Object.assign(new Error("This scenario does not issue page cursors."), { status: 400 });
  }
  if (run.scenario === "empty") return { features: [], nextPageCursor: null, continuation: false };
  if (run.scenario !== "paginated") return { features: all, nextPageCursor: null, continuation: false };
  const requested = url.searchParams.get("pageCursor");
  let offset = 0;
  if (requested !== null) {
    if (!run.state.issuedPageCursors.has(requested)) {
      throw Object.assign(new Error("Page cursor was not issued for this run."), { status: 410 });
    }
    const [kind, cursorRun, offsetText, generation] = requested.split(":");
    if (
      kind !== "page" ||
      cursorRun !== run.id ||
      generation !== run.state.cursorGeneration ||
      !/^(0|[1-9]\d*)$/.test(offsetText ?? "")
    ) {
      throw Object.assign(new Error("Page cursor is stale or belongs to another run."), { status: 410 });
    }
    offset = Number(offsetText);
    if (!Number.isSafeInteger(offset) || offset > all.length) {
      throw Object.assign(new Error("Page cursor offset is invalid."), { status: 410 });
    }
  }
  const features = all.slice(offset, offset + 2);
  const nextOffset = offset + features.length;
  const nextPageCursor = nextOffset < all.length ? `page:${run.id}:${nextOffset}:${run.state.cursorGeneration}` : null;
  if (nextPageCursor) rememberBounded(run.state.issuedPageCursors, nextPageCursor);
  return {
    features,
    nextPageCursor,
    continuation: requested !== null,
  };
}

function validateResumeBinding(run, req, url) {
  if (url.searchParams.getAll("cursor").length > 1) {
    throw Object.assign(new Error("cursor may appear only once."), { status: 400 });
  }
  const hasPageCursor = url.searchParams.has("pageCursor");
  const hasRealtimeCursor = url.searchParams.has("cursor");
  const lastEventId = req.headers["last-event-id"];
  if (Array.isArray(lastEventId)) {
    throw Object.assign(new Error("Only one Last-Event-ID header is allowed."), { status: 400 });
  }
  const hasLastEventId = lastEventId !== undefined;
  if ([hasPageCursor, hasRealtimeCursor, hasLastEventId].filter(Boolean).length > 1) {
    throw Object.assign(new Error("Page and realtime resume checkpoints are mutually exclusive."), { status: 400 });
  }
  const realtimeCursor = url.searchParams.get("cursor");
  if (realtimeCursor !== null) {
    if (!run.state.issuedRealtimeCursors.has(realtimeCursor)) {
      throw Object.assign(new Error("Realtime cursor was not issued for this run."), { status: 410 });
    }
    const [kind, cursorRun, sequenceText, generation] = realtimeCursor.split(":");
    const sequence = Number(sequenceText);
    if (
      kind !== "rt" ||
      cursorRun !== run.id ||
      generation !== run.state.cursorGeneration ||
      !/^(0|[1-9]\d*)$/.test(sequenceText ?? "") ||
      !Number.isSafeInteger(sequence) ||
      sequence > run.state.sequence
    ) {
      throw Object.assign(new Error("Realtime cursor is stale or belongs to another run."), { status: 410 });
    }
  }
  if (lastEventId !== undefined && !run.state.issuedEventIds.has(lastEventId)) {
    throw Object.assign(new Error("Last-Event-ID is stale or belongs to another run."), { status: 410 });
  }
}

function reject(status, message) {
  throw Object.assign(new Error(message), { status });
}

function exactKeys(value, allowed, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(400, `${description} must be an object.`);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) reject(400, `${description} contains unsupported field ${key}.`);
}

function boundedString(value, name, maximum = 128) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || hasAsciiControlCharacters(value)) {
    reject(400, `${name} must be a bounded printable string.`);
  }
  return value;
}

function validateActionBody(action, body) {
  if (
    ["step", "refresh", "reconnect", "resume", "duplicate-event", "stale-cursor", "concurrent-edit"].includes(action)
  ) {
    exactKeys(body, [], `${action} body`);
    return;
  }
  if (action === "edit") {
    exactKeys(body, ["incidentId", "expectedRevision", "idempotencyKey", "patch"], "edit body");
    boundedString(body.incidentId, "incidentId", 64);
    boundedString(body.idempotencyKey, "idempotencyKey", 128);
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) {
      reject(400, "expectedRevision must be a non-negative safe integer.");
    }
    exactKeys(body.patch, ["status", "assignedTo"], "edit patch");
    if (!["open", "assigned", "monitoring", "resolved"].includes(body.patch.status))
      reject(400, "patch.status is invalid.");
    boundedString(body.patch.assignedTo, "patch.assignedTo", 128);
    return;
  }
  if (action === "reset-edit") {
    exactKeys(body, ["incidentId", "idempotencyKey"], "reset body");
    if (body.incidentId !== SAFE_EDIT_ID) reject(400, "Only the isolated demo record can be reset.");
    boundedString(body.idempotencyKey, "idempotencyKey", 128);
  }
}

function idempotencyRequest(operation, body) {
  return canonicalJson({ operation, body });
}

function replayIdempotency(run, operation, body) {
  const prior = run.state.idempotency.get(body.idempotencyKey);
  if (!prior) return undefined;
  if (prior.fingerprint !== idempotencyRequest(operation, body)) {
    return {
      outcome: "conflict",
      operation,
      idempotencyKey: body.idempotencyKey,
      code: "FIXTURE_IDEMPOTENCY_CONFLICT",
      reason: "Idempotency key was already bound to a different fixture action request.",
    };
  }
  return { ...clone(prior.receipt), outcome: "duplicate", reason: "Idempotency key was already applied." };
}

function rememberIdempotency(run, operation, body, receipt) {
  run.state.idempotency.set(body.idempotencyKey, {
    fingerprint: idempotencyRequest(operation, body),
    receipt: clone(receipt),
  });
}

function assertIdempotencyCapacity(run) {
  if (run.state.idempotency.size >= MAXIMUM_IDEMPOTENCY_KEYS) {
    reject(429, `Fixture runs retain at most ${MAXIMUM_IDEMPOTENCY_KEYS} idempotency keys.`);
  }
}

function scenarioHeaders(run) {
  if (run.scenario === "cache-hit") return { age: "10", "x-fixture-cache": "hit; fresh" };
  if (run.scenario === "cache-stale")
    return { age: "600", warning: '110 - "Response is stale"', "x-fixture-cache": "stale" };
  if (run.scenario === "cache-revalidate") return { etag: '"fixture-incidents-v1"', "x-fixture-cache": "revalidated" };
  if (run.scenario === "auth-scope") {
    return { vary: "x-honua-fixture-auth-scope", "x-fixture-cache-scope": run.authScopeFingerprint };
  }
  return {};
}

function sendRange(req, res, value) {
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
  if (!match) {
    sendText(res, 416, "A single byte range is required.", "text/plain; charset=utf-8", {
      "content-range": `bytes */${bytes.length}`,
    });
    return;
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= bytes.length) {
    sendText(res, 416, "Unsatisfiable fixture byte range.", "text/plain; charset=utf-8", {
      "content-range": `bytes */${bytes.length}`,
    });
    return;
  }
  const body = bytes.subarray(start, end + 1);
  res.writeHead(
    206,
    fixtureResponseHeaders(
      { contentLength: body.length, contentType: "application/json; charset=utf-8" },
      { "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${bytes.length}` },
    ),
  );
  res.end(body);
}

function upsertStep(run) {
  const step = run.state.steps[run.state.stepIndex % run.state.steps.length];
  run.state.stepIndex += 1;
  const sequence = nextSequence(run);
  let event;
  if (step.kind === "delete") {
    run.state.features.delete(step.id);
    event = {
      type: "delete",
      eventId: `step-${run.id}-${sequence}`,
      cursor: cursor(run, sequence),
      sequence,
      sourceId: run.state.sourceId,
      id: step.id,
      timestamp: step.eventTime,
      receivedAt: run.clock.now(),
    };
  } else {
    const previous = run.state.features.get(step.id);
    const incident = clone(step.feature ?? { ...previous, ...step.changes, id: step.id, updatedAt: step.eventTime });
    run.state.features.set(incident.id, incident);
    event = {
      type: "upsert",
      eventId: `step-${run.id}-${sequence}`,
      cursor: cursor(run, sequence),
      sequence,
      timestamp: step.eventTime,
      receivedAt: run.clock.now(),
      feature: patch(run, incident),
    };
  }
  broadcast(run, event, true);
  return { label: step.label, kind: step.kind, event };
}

function emitEdit(run, incident, operation, idempotencyKey) {
  const sequence = nextSequence(run);
  const event = {
    type: "upsert",
    eventId: `${operation}-${run.id}-${idempotencyKey}`,
    cursor: cursor(run, sequence),
    sequence,
    timestamp: incident.updatedAt,
    receivedAt: run.clock.now(),
    feature: patch(run, incident),
  };
  broadcast(run, event, true);
}

function editIncident(run, body) {
  const replay = replayIdempotency(run, "edit", body);
  if (replay) return replay;
  const current = run.state.features.get(body.incidentId);
  if (!current?.safeDemoRecord || current.id !== SAFE_EDIT_ID) {
    return {
      outcome: "blocked",
      operation: "edit",
      idempotencyKey: body.idempotencyKey,
      reason: "Only the isolated demo record is editable.",
    };
  }
  const actualRevision = current.revision ?? 0;
  if (run.scenario === "edit-conflict" || body.expectedRevision !== actualRevision) {
    return {
      outcome: "conflict",
      operation: "edit",
      idempotencyKey: body.idempotencyKey,
      expectedRevision: body.expectedRevision,
      actualRevision,
      reason: "The fixture revision changed before the edit was applied.",
    };
  }
  assertIdempotencyCapacity(run);
  const incident = {
    ...current,
    ...body.patch,
    revision: actualRevision + 1,
    updatedAt: run.clock.iso(),
  };
  run.state.features.set(incident.id, incident);
  const receipt = {
    outcome: "applied",
    operation: "edit",
    idempotencyKey: body.idempotencyKey,
    incident: clone(incident),
    expectedRevision: body.expectedRevision,
    actualRevision: incident.revision,
    reason: "Isolated fixture edit applied.",
  };
  rememberIdempotency(run, "edit", body, receipt);
  emitEdit(run, incident, "edit", body.idempotencyKey);
  return receipt;
}

export function createIncidentOperationsHandler(pack) {
  const snapshot = pack.data[pack.manifest.schema.files.snapshot];
  const events = pack.data[pack.manifest.schema.files.events];
  const baseline = new Map(snapshot.features.map((feature) => [feature.id, clone(feature)]));

  return Object.freeze({
    id: "incident-operations",
    createRunState(run) {
      return {
        sourceId: snapshot.sourceId,
        layerId: snapshot.layerId,
        baseline: new Map([...baseline].map(([id, feature]) => [id, clone(feature)])),
        features: new Map([...baseline].map(([id, feature]) => [id, clone(feature)])),
        steps: clone(events.steps),
        stepIndex: 0,
        sequence: 0,
        cursorGeneration: run.ids.next("cursor"),
        throttleRemaining: 1,
        idempotency: new Map(),
        lastDataEvent: undefined,
        issuedEventIds: new Set(),
        issuedPageCursors: new Set(),
        issuedRealtimeCursors: new Set(),
        subscribers: new Set(),
      };
    },
    disposeRunState(run, reason) {
      for (const subscriber of [...(run.state?.subscribers ?? [])]) subscriber.close(reason);
      run.state?.subscribers.clear();
    },
    inspectRunState(run) {
      return {
        featureCount: run.state.features.size,
        stepIndex: run.state.stepIndex,
        sequence: run.state.sequence,
        cursorGeneration: run.state.cursorGeneration,
        subscriberCount: run.state.subscribers.size,
        idempotencyKeyCount: run.state.idempotency.size,
      };
    },
    handle({ req, res, url, run }) {
      if (req.method === "GET" && url.pathname === CAPABILITIES_PATH) {
        if (run.scenario === "cache-revalidate" && req.headers["if-none-match"] === '"fixture-incidents-v1"') {
          res.writeHead(304, fixtureHeaders(scenarioHeaders(run)));
          res.end();
          return true;
        }
        sendJson(
          res,
          200,
          { enabled: true, data: { enabled: true, transport: "sse", minimumEdition: "Community" } },
          scenarioHeaders(run),
        );
        return true;
      }
      if (req.method === "GET" && url.pathname === "/api/v1/incidents") {
        const value = { features: [...run.state.features.values()] };
        if (run.scenario === "range") sendRange(req, res, value);
        else sendJson(res, 200, value, scenarioHeaders(run));
        return true;
      }
      if (req.method !== "GET" || url.pathname !== STREAM_PATH) return false;
      if (run.scenario === "unsupported") {
        sendJson(res, 501, { error: { code: "FIXTURE_UNSUPPORTED", capability: "realtime" } });
        return true;
      }
      if (run.scenario === "abort") {
        sendJson(
          res,
          499,
          { error: { code: "FIXTURE_ABORT", message: "Stream aborted before subscription." } },
          {
            "x-fixture-abort": "client-before-body",
          },
        );
        return true;
      }
      if (run.scenario === "throttled" && run.state.throttleRemaining > 0) {
        run.state.throttleRemaining -= 1;
        sendJson(res, 429, { error: { code: "FIXTURE_THROTTLED", retryable: true } }, { "retry-after": "0" });
        return true;
      }
      if (run.scenario === "stale-cursor") {
        sendJson(res, 410, { error: { code: "FIXTURE_STALE_CURSOR", message: "Realtime cursor expired." } });
        return true;
      }
      if (run.state.subscribers.size >= 8) {
        sendJson(res, 429, { error: { code: "FIXTURE_STREAM_CAPACITY", maximumSubscribers: 8 } });
        return true;
      }

      let selected;
      try {
        validateResumeBinding(run, req, url);
        selected = resolveStreamFeatures(run, url);
      } catch (error) {
        const status = error.status ?? 400;
        sendJson(res, status, {
          error: {
            code: status === 410 ? "FIXTURE_STALE_CURSOR" : "FIXTURE_INVALID_CURSOR_BINDING",
            message: error.message,
          },
        });
        return true;
      }
      const subscriber = createSseSubscriber(req, res, {
        maximumQueuedEvents: 32,
        onClose: () => run.state.subscribers.delete(subscriber),
      });
      run.state.subscribers.add(subscriber);
      const initial = snapshotEvent(run, { features: selected.features, replace: !selected.continuation });
      initial.pageCursor = selected.nextPageCursor;
      if (run.scenario === "schema-drift" && initial.features[0]) {
        initial.features[0].feature = { ...initial.features[0].feature, coordinate: "schema-drift" };
      }
      subscriber.send(initial);
      rememberRealtimeIdentity(run, initial);
      run.state.lastDataEvent = clone(initial);
      const heartbeat = heartbeatEvent(run);
      subscriber.send(heartbeat);
      rememberRealtimeIdentity(run, heartbeat);
      if (run.scenario === "duplicate-event") subscriber.send(initial);
      if (run.scenario === "reconnect") {
        subscriber.send(
          statusEvent(run, "reconnecting", {
            reason: "fixture-network-interruption",
            reconnectAttempt: 1,
            retryAfterMs: 0,
          }),
        );
      }
      return true;
    },
    handleAction({ action, body, run }) {
      validateActionBody(action, body);
      if (action === "step") return { status: 200, body: upsertStep(run) };
      if (action === "refresh") {
        const event = snapshotEvent(run);
        broadcast(run, event, true);
        return { status: 200, body: { refreshed: true, event } };
      }
      if (action === "reconnect") {
        const event = statusEvent(run, "reconnecting", {
          reason: "fixture-network-interruption",
          reconnectAttempt: 1,
          retryAfterMs: 0,
        });
        broadcast(run, event);
        return { status: 200, body: { reconnecting: true } };
      }
      if (action === "resume") {
        const event = statusEvent(run, "live", {
          cursor: cursor(run, run.state.sequence),
          reason: "fixture-resume-succeeded",
          reconnectAttempt: 1,
        });
        broadcast(run, event);
        broadcast(run, heartbeatEvent(run));
        return { status: 200, body: { resumed: true } };
      }
      if (action === "duplicate-event") {
        if (run.state.lastDataEvent) broadcast(run, clone(run.state.lastDataEvent));
        return { status: 200, body: { duplicated: Boolean(run.state.lastDataEvent) } };
      }
      if (action === "stale-cursor") {
        const incident = run.state.features.get(SAFE_EDIT_ID);
        const event = {
          type: "upsert",
          eventId: `stale-cursor-${run.id}`,
          cursor: `${run.id}:0:${run.state.cursorGeneration}`,
          sequence: 0,
          receivedAt: run.clock.now(),
          feature: patch(run, incident),
        };
        broadcast(run, event);
        return { status: 200, body: { staleCursorInjected: true } };
      }
      if (action === "edit") {
        const receipt = editIncident(run, body);
        return { status: receipt.outcome === "conflict" ? 409 : 200, body: receipt };
      }
      if (action === "reset-edit") {
        const replay = replayIdempotency(run, "reset", body);
        if (replay) return { status: replay.outcome === "conflict" ? 409 : 200, body: replay };
        assertIdempotencyCapacity(run);
        const baselineFeature = clone(run.state.baseline.get(SAFE_EDIT_ID));
        const current = run.state.features.get(SAFE_EDIT_ID);
        const incident = { ...baselineFeature, revision: (current?.revision ?? 0) + 1, updatedAt: run.clock.iso() };
        run.state.features.set(incident.id, incident);
        const receipt = {
          outcome: "reset",
          operation: "reset",
          idempotencyKey: body.idempotencyKey,
          incident: clone(incident),
          actualRevision: incident.revision,
          reason: "Isolated fixture record reset to its baseline values.",
        };
        rememberIdempotency(run, "reset", body, receipt);
        emitEdit(run, incident, "reset", body.idempotencyKey);
        return { status: 200, body: receipt };
      }
      if (action === "concurrent-edit") {
        const current = run.state.features.get(SAFE_EDIT_ID);
        const incident = {
          ...current,
          assignedTo: "Concurrent Fixture Operator",
          revision: (current.revision ?? 0) + 1,
          updatedAt: run.clock.iso(),
        };
        run.state.features.set(incident.id, incident);
        emitEdit(run, incident, "external", run.ids.next("external"));
        return { status: 200, body: { incident } };
      }
      return { status: 404, body: { error: { code: "FIXTURE_UNKNOWN_ACTION", action } } };
    },
  });
}
