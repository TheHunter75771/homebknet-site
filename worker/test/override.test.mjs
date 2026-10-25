// The undici override tripwire: the override must not sit below the lowest version that the
// dependent's declared spec allows, whether that spec is an exact pin or a range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { minVersion, overrideProblem } from './helpers/semver-min.mjs';

test('minVersion: exact versions and = / v prefixes', () => {
  for (const spec of ['7.31.0', '=7.31.0', 'v7.31.0', '= 7.31.0', ' 7.31.0 ']) assert.deepEqual(minVersion(spec), [7, 31, 0], spec);
});

test('minVersion: caret, tilde, >= and > ranges', () => {
  assert.deepEqual(minVersion('^7.31.0'), [7, 31, 0]);
  assert.deepEqual(minVersion('~7.31.0'), [7, 31, 0]);
  assert.deepEqual(minVersion('>=7.31.0'), [7, 31, 0]);
  assert.deepEqual(minVersion('>= 7.31.0'), [7, 31, 0]);
  assert.deepEqual(minVersion('^7.31'), [7, 31, 0]);
  assert.deepEqual(minVersion('~7'), [7, 0, 0]);
  assert.deepEqual(minVersion('>7.30.1'), [7, 30, 2]);
  assert.deepEqual(minVersion('>7.30'), [7, 31, 0]);
  assert.deepEqual(minVersion('>7'), [8, 0, 0]);
});

test('minVersion: x-ranges, sets, hyphens and alternatives', () => {
  assert.deepEqual(minVersion('7.31.x'), [7, 31, 0]);
  assert.deepEqual(minVersion('7.x'), [7, 0, 0]);
  assert.deepEqual(minVersion('*'), [0, 0, 0]);
  assert.deepEqual(minVersion(''), [0, 0, 0]);
  assert.deepEqual(minVersion('<8.0.0'), [0, 0, 0], 'an upper bound alone does not raise the minimum');
  assert.deepEqual(minVersion('>=7.31.0 <8.0.0'), [7, 31, 0]);
  assert.deepEqual(minVersion('>=7.0.0 >=7.31.2 <8'), [7, 31, 2], 'the highest lower bound in a set wins');
  assert.deepEqual(minVersion('7.31.0 - 7.40.0'), [7, 31, 0]);
  assert.deepEqual(minVersion('7.31 - 8'), [7, 31, 0]);
  assert.deepEqual(minVersion('^7.33.0 || ^7.31.2'), [7, 31, 2], 'the lowest alternative wins');
  assert.deepEqual(minVersion('7.31.0-beta.2'), [7, 31, 0]);
  assert.deepEqual(minVersion('^7.31.0+build.5'), [7, 31, 0]);
});

test('minVersion: specs it cannot read return null', () => {
  for (const spec of ['latest', 'next', 'npm:undici@^7.31.0', 'git+https://example.com/undici.git', 'file:../undici', 'workspace:*', '>*', '^7.31.0 || banana', '>=7.31.0 - 8', null, undefined, 7]) {
    assert.equal(minVersion(spec), null, String(spec));
  }
});

test('the override passes when it meets the declared minimum', () => {
  for (const spec of ['7.29.1', '7.30.1', '^7.29.0', '~7.30.0', '>=7.30.1', '>=7.30.0 <8', '7.x', '^7.30.1 || ^8.0.0', '*']) {
    assert.equal(overrideProblem('7.30.1', spec), null, spec);
  }
});

test('the override fails when the declared minimum is higher: exact, caret, tilde, >=, >, ranges', () => {
  for (const spec of ['7.31.0', '^7.31.0', '~7.31.0', '>=7.31.0', '>= 7.31.0', '>7.30.1', '>=7.31.0 <8.0.0', '7.31.0 - 7.40.0', '7.31.x', '^8.0.0', '^7.32.0 || ^7.31.0']) {
    const problem = overrideProblem('7.30.1', spec);
    assert.match(String(problem), /would downgrade it/, spec);
  }
});

test('the override fails closed on a spec it cannot read, or on an inexact override', () => {
  assert.match(String(overrideProblem('7.30.1', 'latest')), /can't read/);
  assert.match(String(overrideProblem('7.30.1', 'npm:undici@^7.31.0')), /can't read/);
  assert.match(String(overrideProblem('^7.30.1', '7.29.1')), /not an exact version/);
});
