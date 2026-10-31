import { describe, it } from 'vitest';
import { referenceEngine } from './engine/reference.js';
import { SCENARIOS } from './scenarios.js';

const acs = SCENARIOS.filter((s) => s.id.startsWith('AC'));

describe('AC01–AC14 反例场景（虚构数据）', () => {
  for (const s of acs) {
    it(`${s.id} ${s.title}`, () => {
      s.run(referenceEngine);
    });
  }
});
