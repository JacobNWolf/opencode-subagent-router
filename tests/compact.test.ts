import { expect, test } from 'bun:test';

import { compact } from '../src/compact';

test('omits only undefined values without mutating the input', () => {
  const input = { missing: undefined, zero: 0, disabled: false, empty: '', nullable: null };
  expect(compact(input)).toEqual({ zero: 0, disabled: false, empty: '', nullable: null });
  expect(Object.hasOwn(input, 'missing')).toBeTrue();
});
