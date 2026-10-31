import { describe, it, expect } from 'vitest';
import { referenceEngine } from './engine/reference.js';
import { MUTANTS } from './engine/mutants.js';
import { SCENARIOS } from './scenarios.js';

describe('元测试：反例必须能捕获违规实现', () => {
  it('参考实现应通过全部场景', () => {
    for (const s of SCENARIOS) {
      expect(() => s.run(referenceEngine), `${s.id} ${s.title}`).not.toThrow();
    }
  });

  for (const m of MUTANTS) {
    it(`${m.name}（违反 ${m.violates}）应被 ${m.expectedFailure} 捕获`, () => {
      const target = SCENARIOS.find((s) => s.id === m.expectedFailure);
      expect(target, `变异体 ${m.name} 指定的场景 ${m.expectedFailure} 不存在`).toBeDefined();
      expect(() => target!.run(m.engine)).toThrow();
    });
  }

  it('变异体数量应不少于 10 个', () => {
    expect(MUTANTS.length).toBeGreaterThanOrEqual(10);
  });
});
