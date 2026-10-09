// Pure geometry for day timelines. Minutes count from the day's Manila midnight; 1440 is the next one.
export type Span = { start: number; end: number };
export const DAY_MINUTES = 1440;
export const SLOT_MINUTES = 30;

/**
 * Whole hours covering every span, clipped to the day and at least `minHours` long.
 * `fallback` frames a day with nothing on it.
 */
export function timelineRange(spans: readonly Span[], fallback: Span, minHours = 4): Span {
  const real = spans.filter((s) => s.end > s.start);
  if (!real.length) return fallback;
  let start = Math.max(0, Math.floor(Math.min(...real.map((s) => s.start)) / 60) * 60);
  let end = Math.min(DAY_MINUTES, Math.ceil(Math.max(...real.map((s) => s.end)) / 60) * 60);
  const missing = minHours * 60 - (end - start);
  if (missing > 0) {
    end = Math.min(DAY_MINUTES, end + missing);
    start = Math.max(0, end - minHours * 60);
  }
  return { start, end };
}
export function hourMarks(range: Span): number[] {
  const marks: number[] = [];
  for (let m = Math.ceil(range.start / 60) * 60; m <= range.end; m += 60) marks.push(m);
  return marks;
}
/** The slot under a tap, `offset` pixels below the range start, snapped down to the slot size. */
export function minuteAt(offset: number, hourHeight: number, range: Span, step = SLOT_MINUTES): number {
  const raw = range.start + (offset / hourHeight) * 60;
  const snapped = Math.floor(raw / step) * step;
  return Math.min(range.end - step, Math.max(range.start, snapped));
}
/** Vertical placement of a span clipped to the range; null when it falls outside. */
export function frameOf(span: Span, range: Span, hourHeight: number): { top: number; height: number } | null {
  const start = Math.max(span.start, range.start); const end = Math.min(span.end, range.end);
  if (end <= start) return null;
  return { top: ((start - range.start) / 60) * hourHeight, height: ((end - start) / 60) * hourHeight };
}
/**
 * Side-by-side lanes for overlapping items in one column: each item gets a lane and the
 * lane count of its overlap cluster. Court inventory never overlaps, so this is a fallback.
 */
export function assignLanes<T extends Span>(items: readonly T[]): { item: T; lane: number; lanes: number }[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed: { item: T; lane: number; lanes: number }[] = [];
  let cluster: { item: T; lane: number; lanes: number }[] = []; let laneEnds: number[] = []; let clusterEnd = -Infinity;
  const close = () => { for (const p of cluster) p.lanes = laneEnds.length; cluster = []; laneEnds = []; };
  for (const item of sorted) {
    if (item.start >= clusterEnd) close();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane < 0) { lane = laneEnds.length; laneEnds.push(item.end); } else laneEnds[lane] = item.end;
    const entry = { item, lane, lanes: 1 };
    cluster.push(entry); placed.push(entry);
    clusterEnd = Math.max(clusterEnd, item.end);
  }
  close();
  return placed;
}
