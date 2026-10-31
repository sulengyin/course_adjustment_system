import type { HistoryEvent } from './types.js';

/** 供夹具与引擎共用的审计链哈希（仅用于验证"未被抹除/未被改写"）。 */
export function chainHash(prevHash: string, ev: Pick<HistoryEvent, 'id' | 'type' | 'at' | 'actorId' | 'payload'>): string {
  const s = [prevHash, ev.id, ev.type, ev.at, ev.actorId, ev.payload].join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
