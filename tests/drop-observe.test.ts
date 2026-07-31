import { describe, expect, it } from 'vitest';
import { pollIntervalMs } from '../src/trigger/drop-observe.js';

describe('pollIntervalMs', () => {
  it('горячий режим (2с) в минуты 57–59 — дроп приходит в H:58:50–59:05', () => {
    for (const m of [57, 58, 59]) expect(pollIntervalMs(m)).toBe(2_000);
  });

  it('горячий режим держится до 3-й минуты следующего часа (поздний дроп)', () => {
    for (const m of [0, 1, 2, 3]) expect(pollIntervalMs(m)).toBe(2_000);
  });

  it('в остальное время — щадящие 10с (правило CLAUDE.md: не DDoS-ить)', () => {
    for (const m of [4, 10, 30, 50, 56]) expect(pollIntervalMs(m)).toBe(10_000);
  });
});
