const test = require('node:test');
const assert = require('node:assert/strict');
const { add, multiply } = require('./calc');

test('add correctly computes sum of positive integers', () => {
  assert.equal(add(2, 3), 5);
});

test('add handles negative numbers and zero', () => {
  assert.equal(add(-1, 1), 0);
  assert.equal(add(0, 0), 0);
});

test('multiply correctly computes product', () => {
  assert.equal(multiply(3, 4), 12);
});
