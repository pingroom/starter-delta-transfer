import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', 'unknown'].includes(value);
const HEX = /^(?:[0-9a-fA-F]{2}){0,2048}$(?![\s\S])/;
const DIGEST = /^[0-9a-f]{64}$(?![\s\S])/;
export const MIN_COPY = 4;
export const MAX_BYTES = 2048;
export const bytesHash = hex => createHash('sha256').update(decodeHex(hex)).digest('hex');
function decodeHex(hex) {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error('Expected even-length hexadecimal for 0..2048 bytes, without whitespace.');
  return Buffer.from(hex, 'hex');
}
export const POLICY = Object.freeze({ name: 'greedy-byte-delta-v1',
  bounds: '0..2048 bytes per target and baseline, 1..3 distinct candidate baselines',
  matching: 'longest baseline match at each target offset; lowest baseline offset wins ties',
  encoding: 'COPY at length at least 4; otherwise coalesce literal bytes until the next copy',
  verification: 'exact SHA-256 and byte lengths for supplied baseline and reconstructed target',
  format: 'custom JSON COPY/LITERAL; no VCDIFF, bsdiff or rsync compatibility or minimum-size promise',
  execution: 'local patch and reconstruction only; no transfer, installation or original-file writes' });
export const POLICY_HASH = hash(POLICY);
const promptFor = input => `${input.title}\n${input.context}\nFor ${input.transferId}, which baseline is currently installed?\n${input.baselines.map(b => `${b.label}: ${b.reference}`).join('\n')}\nChoose from the installed version record, or Unknown. Byte contents stay local.`;
export function validateInput(input) {
  if (!keys(input, ['transferId', 'title', 'context', 'targetHex', 'baselines']) || !word(input.transferId)
    || !line(input.title, 40) || !line(input.context, 80)
    || !Array.isArray(input.baselines) || input.baselines.length < 1 || input.baselines.length > 3) throw new Error('Supply transfer metadata, target hex and 1..3 baseline snapshots.');
  const targetHex = decodeHex(input.targetHex).toString('hex'), ids = new Set(), labels = new Set(), contents = new Set();
  const baselines = Array.from(input.baselines, baseline => {
    if (!keys(baseline, ['id', 'label', 'reference', 'hex']) || !safeId(baseline.id)
      || !line(baseline.label, 24) || baseline.label.toLowerCase() === 'unknown' || !line(baseline.reference, 40)
      || ids.has(baseline.id) || labels.has(baseline.label)) throw new Error('Baselines need unique safe IDs and labels, a source reference and hex bytes.');
    const hex = decodeHex(baseline.hex).toString('hex');
    if (contents.has(hex)) throw new Error('Baseline snapshots must have distinct byte contents.');
    ids.add(baseline.id); labels.add(baseline.label); contents.add(hex); return { id: baseline.id, label: baseline.label, reference: baseline.reference, hex };
  });
  const result = { transferId: input.transferId, title: input.title, context: input.context, targetHex, baselines };
  if (promptFor(result).length > 500) throw new Error('Baseline Question exceeds 500 UTF-16 units. Shorten metadata or references.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact installed-version owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = rawInput => { validateInput(rawInput); return [{ id: 'baseline' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'baseline' || !isId(attemptId)) throw new Error('Invalid baseline selection or attempt.');
  const key = `delta-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [...input.baselines.map(b => ({ value: b.id, label: b.label, style: 'default' })), { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), target_hash: bytesHash(input.targetHex), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'baseline', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'The attempt UUID, correlation ID and input/target/policy hashes are bound when a session creates its Question.' };
}
function descriptor(hex) { return { bytes: hex.length / 2, sha256: bytesHash(hex) }; }
function validDescriptor(value) {
  return keys(value, ['bytes', 'sha256']) && Number.isSafeInteger(value.bytes) && !Object.is(value.bytes, -0)
    && value.bytes >= 0 && value.bytes <= MAX_BYTES && typeof value.sha256 === 'string' && DIGEST.test(value.sha256);
}
/** Pure bounded interpreter. Hashes verify supplied bytes, not publisher identity. */
export function applyDelta(patch, baselineHex) {
  const baseline = decodeHex(baselineHex);
  if (!keys(patch, ['version', 'algorithm', 'baseline', 'target', 'operations']) || patch.version !== 1 || patch.algorithm !== POLICY.name
    || !validDescriptor(patch.baseline) || !validDescriptor(patch.target) || !Array.isArray(patch.operations)
    || patch.operations.length > MAX_BYTES) throw new Error('Invalid bounded delta patch.');
  if (baseline.length !== patch.baseline.bytes || bytesHash(baselineHex) !== patch.baseline.sha256) throw new Error('Baseline size or SHA-256 differs from the patch.');
  const chunks = []; let total = 0;
  for (const op of Array.from(patch.operations)) {
    let chunk;
    if (keys(op, ['type', 'offset', 'length']) && op.type === 'COPY') {
      if (!Number.isSafeInteger(op.offset) || Object.is(op.offset, -0) || op.offset < 0
        || !Number.isSafeInteger(op.length) || op.length < MIN_COPY || op.length > MAX_BYTES
        || op.offset + op.length > baseline.length) throw new Error('COPY is outside the baseline or below the minimum length.');
      chunk = baseline.subarray(op.offset, op.offset + op.length);
    } else if (keys(op, ['type', 'hex']) && op.type === 'LITERAL') {
      chunk = decodeHex(op.hex);
      if (chunk.length === 0 || op.hex !== chunk.toString('hex')) throw new Error('LITERAL must contain nonempty lowercase hex.');
    } else throw new Error('Unrecognized delta operation.');
    total += chunk.length;
    if (total > patch.target.bytes) throw new Error('Delta output exceeds its declared target size.');
    chunks.push(chunk);
  }
  const result = Buffer.concat(chunks, total).toString('hex');
  if (total !== patch.target.bytes || bytesHash(result) !== patch.target.sha256) throw new Error('Reconstructed target size or SHA-256 differs from the patch.');
  return result;
}
/** Greedy longest matches; O(target bytes * baseline bytes), with two DP rows. */
export function buildDelta(rawInput, baselineId) {
  const input = validateInput(rawInput), selected = input.baselines.find(b => b.id === baselineId);
  if (!selected) throw new Error('Select a supplied baseline before building a delta.');
  const base = decodeHex(selected.hex), target = decodeHex(input.targetHex);
  let next = new Uint16Array(base.length + 1), row = new Uint16Array(base.length + 1);
  const lengths = new Uint16Array(target.length), offsets = new Uint16Array(target.length);
  for (let i = target.length - 1; i >= 0; i--) {
    let length = 0, offset = 0;
    for (let j = 0; j < base.length; j++) {
      row[j] = target[i] === base[j] ? next[j + 1] + 1 : 0;
      if (row[j] > length) { length = row[j]; offset = j; }
    }
    lengths[i] = length; offsets[i] = offset; [next, row] = [row, next];
  }
  const operations = []; let cursor = 0, copiedBytes = 0, literalBytes = 0;
  while (cursor < target.length) {
    if (lengths[cursor] >= MIN_COPY) {
      const length = lengths[cursor]; operations.push({ type: 'COPY', offset: offsets[cursor], length }); copiedBytes += length; cursor += length;
    } else {
      const start = cursor++;
      while (cursor < target.length && lengths[cursor] < MIN_COPY) cursor++;
      const hex = target.subarray(start, cursor).toString('hex'); operations.push({ type: 'LITERAL', hex }); literalBytes += cursor - start;
    }
  }
  const patch = { version: 1, algorithm: POLICY.name, baseline: descriptor(selected.hex), target: descriptor(input.targetHex), operations };
  if (applyDelta(patch, selected.hex) !== input.targetHex) throw new Error('Delta failed its exact reconstruction check.');
  return { baselineId, patch, copiedBytes, literalBytes, operationCount: operations.length, reconstructionVerified: true, filesChanged: false, transferred: false };
}
export function deltaPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (choice !== null && choice !== 'unknown' && !input.baselines.some(b => b.id === choice)) throw new Error('Supply a known baseline, Unknown or a missing selection.');
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete', analysis: choice === null || choice === 'unknown' ? null : buildDelta(input, choice) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed transfer metadata. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved baseline selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'baseline', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = deltaPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, transferId: input.transferId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

export function handoff(report) {
  if (report.status !== 'complete' || report.analysis === null) throw new Error('A known installed baseline is required before export.');
  return { version: 1, status: 'complete', patch: report.analysis.patch,
    evidence: { transferId: report.transferId, sourceHash: report.sourceHash, policy: report.policy, policyHash: report.policyHash,
      participant: report.participant, room: report.room, configHash: report.configHash, answers: report.answers,
      baselineId: report.analysis.baselineId, copiedBytes: report.analysis.copiedBytes, literalBytes: report.analysis.literalBytes } };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved baseline selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered baseline selections must not contain baseline selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
