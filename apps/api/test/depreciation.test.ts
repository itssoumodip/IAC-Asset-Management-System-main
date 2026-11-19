import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDepreciationCharge } from '../src/depreciation';

test('SLM uses cost less residual value over the asset useful life', () => {
  assert.equal(
    calculateDepreciationCharge({
      calculationType: 'SLM',
      purchaseCost: 100_000,
      residualValue: 10_000,
      openingValue: 90_000,
      usefulLifeYears: 5,
      ratePercent: 15,
    }),
    18_000,
  );
});

test('WDV uses the method configured rate against opening value', () => {
  assert.equal(
    calculateDepreciationCharge({
      calculationType: 'WDV',
      purchaseCost: 100_000,
      residualValue: 10_000,
      openingValue: 80_000,
      usefulLifeYears: 5,
      ratePercent: 25,
    }),
    20_000,
  );
});
