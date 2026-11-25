import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateDepreciationCharge } from '../src/depreciation';

const base = { purchaseCost: 100_000, residualValue: 10_000, usefulLifeYears: 5, ratePercent: 25 };

test('SLM uses cost less residual value over the asset useful life', () => {
  assert.equal(
    calculateDepreciationCharge({ ...base, calculationType: 'SLM', openingValue: 90_000 }),
    18_000,
  );
});

test('SLM never takes the value below the residual value', () => {
  assert.equal(
    calculateDepreciationCharge({ ...base, calculationType: 'SLM', openingValue: 15_000 }),
    5_000,
  );
});

test('WDV uses the method configured rate against opening value', () => {
  assert.equal(
    calculateDepreciationCharge({ ...base, calculationType: 'WDV', openingValue: 80_000 }),
    20_000,
  );
});

test('WDV keeps going below the scrap value, as the finance register does', () => {
  // Laptop from the register: cost 121000, WDV 2437 at 31-3-2025, 63.16% → 1539 for 2025-26.
  assert.equal(
    calculateDepreciationCharge({
      calculationType: 'WDV',
      purchaseCost: 121_000,
      residualValue: 6_050,
      openingValue: 2_437,
      usefulLifeYears: 3,
      ratePercent: 63.16,
    }),
    1_539,
  );
});

test('the first year counts only the days in service, in whole rupees', () => {
  // Register: ROUND(cost × rate × days ÷ 365, 0); in service from 12 Jan to 31 Mar = 79 days.
  assert.equal(
    calculateDepreciationCharge({
      ...base,
      calculationType: 'WDV',
      purchaseCost: 5_430,
      openingValue: 5_430,
      ratePercent: 45.07,
      daysInService: 79,
    }),
    Math.round(5_430 * 0.4507 * (79 / 365)),
  );
});

test('no-depreciation methods charge nothing', () => {
  assert.equal(
    calculateDepreciationCharge({ ...base, calculationType: 'NONE', openingValue: 100_000 }),
    0,
  );
});
