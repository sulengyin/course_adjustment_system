import { describe, it } from 'vitest';
import { referenceEngine } from './engine/reference.js';
import { SCENARIOS } from './scenarios.js';

const v23 = SCENARIOS.filter((s) => s.id.startsWith('V23'));

describe('V2.3 必测场景（可自动化部分）', () => {
  for (const s of v23) {
    it(`${s.id} ${s.title}`, () => {
      s.run(referenceEngine);
    });
  }
});
