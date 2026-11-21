import { createHash } from "node:crypto";
import { measureContext, type ContextLimits, type TokenCounter } from "./context-size";

export const hashText = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface ContextSource {
  id: string;
  path: string;
  revision: string;
  kind: string;
  bytes: number;
  originalHash: string;
  viewHash: string;
  transformation: string;
  read(from: number, to: number): Promise<Buffer>;
}
export interface SourceUnit {
  id: string;
  source: ContextSource;
  from: number;
  to: number;
}
export function sourceUnit(source: ContextSource, from = 0, to = source.bytes): SourceUnit {
  if (![from, to].every(Number.isSafeInteger) || from < 0 || to < from || to > source.bytes) throw new Error("Invalid source range");
  return { source, from, to, id: hashText(JSON.stringify([source.id, from, to])) };
}
export async function unitText(unit: SourceUnit): Promise<string> {
  const bytes = await unit.source.read(unit.from, unit.to);
  if (bytes.length !== unit.to - unit.from) throw new Error("Source changed or incomplete read");
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
/** UTF-8 boundaries, preferring a nearby line boundary without discarding CR/LF. */
export async function splitTextUnit(unit: SourceUnit): Promise<SourceUnit[]> {
  const size = unit.to - unit.from;
  if (size < 2) throw new Error("unsupported_unit: one character cannot fit request");
  // Only inspect a bounded region around the midpoint, never read the entire large file.
  const middle = unit.from + Math.floor(size / 2);
  const start = Math.max(unit.from, middle - 2048);
  const end = Math.min(unit.to, middle + 2048);
  const buffer = await unit.source.read(start, end);
  let cut = middle;
  const newline = buffer.indexOf(10, middle - start);
  if (newline >= 0 && start + newline + 1 < unit.to) cut = start + newline + 1;
  else {
    while (cut > unit.from && (buffer[cut - start] & 0xc0) === 0x80) cut--;
  }
  if (cut <= unit.from || cut >= unit.to) throw new Error("unsupported_unit: one character cannot fit request");
  return [sourceUnit(unit.source, unit.from, cut), sourceUnit(unit.source, cut, unit.to)];
}
export interface ContextPart<Request> {
  id: string;
  units: SourceUnit[];
  requestHash: string;
  /** Phantom type: requests are rebuilt on dispatch, not retained for the whole repository. */
  requestType?: Request;
  measurement: ReturnType<typeof measureContext>;
}
export interface PackOptions<Request> {
  limits: ContextLimits;
  counter?: TokenCounter;
  template(units: SourceUnit[]): Promise<Request>;
  split?(unit: SourceUnit): Promise<SourceUnit[]>;
  version: string;
}
/** Templates use stable unit IDs; display ordinals must never alter a submitted request. */
export async function packContext<Request>(sources: ContextSource[], options: PackOptions<Request>): Promise<ContextPart<Request>[]> {
  if (new Set(sources.map(source => source.id)).size !== sources.length) throw new Error("Duplicate sources");
  return packUnits(sources.map(source => sourceUnit(source)), options);
}
/** Repack only failed ranges; completed siblings retain their identities and responses. */
export async function packUnits<Request>(expected: SourceUnit[], options: PackOptions<Request>): Promise<ContextPart<Request>[]> {
  const empty = await options.template([]);
  if (!measureContext(empty, options.limits, options.counter).fits) throw new Error("configuration_error: mandatory context does not fit");
  const out: ContextPart<Request>[] = [];
  let current: SourceUnit[] = [];
  const finish = async () => {
    if (!current.length) return;
    const request = await options.template(current);
    const measurement = measureContext(request, options.limits, options.counter);
    if (!measurement.fits) throw new Error("configuration_error: non-deterministic request template");
    const requestHash = hashText(JSON.stringify(request));
    out.push({ id: hashText(JSON.stringify([options.version, current.map(u => u.id), requestHash])), units: current, requestHash, measurement });
    current = [];
  };
  const admit = async (unit: SourceUnit): Promise<void> => {
    const request = await options.template([...current, unit]);
    if (measureContext(request, options.limits, options.counter).fits) { current.push(unit); return; }
    if (current.length) { await finish(); await admit(unit); return; }
    const children = await (options.split ?? splitTextUnit)(unit);
    if (children.length < 2 || children.some(child => child.to - child.from >= unit.to - unit.from)) throw new Error("Splitter made no progress");
    assertUnitCoverage([unit], children);
    for (const child of children) await admit(child);
  };
  for (const unit of expected) await admit(unit);
  await finish();
  assertUnitCoverage(expected, out.flatMap(part => part.units));
  return out;
}
export async function rebuildPartRequest<Request>(part: ContextPart<Request>, options: PackOptions<Request>): Promise<Request> {
  const request = await options.template(part.units);
  if (hashText(JSON.stringify(request)) !== part.requestHash) throw new Error("Context artifact changed after admission");
  if (!measureContext(request, options.limits, options.counter).fits) throw new Error("Context no longer fits selected model");
  return request;
}
export function assertUnitCoverage(expected: SourceUnit[], actual: SourceUnit[]) {
  const ranges = new Map<string, SourceUnit[]>();
  const allowed = new Map<string, SourceUnit[]>();
  for (const parent of expected) { const group = allowed.get(parent.source.id) ?? []; group.push(parent); allowed.set(parent.source.id, group); }
  for (const unit of actual) {
    const group = ranges.get(unit.source.id) ?? [];
    group.push(unit); ranges.set(unit.source.id, group);
  }
  for (const parent of expected) {
    const group = (ranges.get(parent.source.id) ?? []).filter(unit => unit.from >= parent.from && unit.to <= parent.to).sort((a, b) => a.from - b.from);
    let offset = parent.from;
    if (!group.length) throw new Error("Coverage missing source");
    for (const unit of group) {
      if (unit.source.viewHash !== parent.source.viewHash || unit.from !== offset || unit.to < unit.from) throw new Error("Coverage gap, overlap or changed source");
      offset = unit.to;
    }
    if (offset !== parent.to) throw new Error("Coverage incomplete");
  }
  for (const unit of actual) if (!(allowed.get(unit.source.id) ?? []).some(parent => unit.from >= parent.from && unit.to <= parent.to)) throw new Error("Coverage contains unexpected unit");
}
