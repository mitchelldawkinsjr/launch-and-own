import test from 'node:test';
import assert from 'node:assert/strict';
import {consistency, screenKey} from './visual-walkthrough.mjs';

test('the most common value is the house style; missing elements and customer sites are not flagged', () => {
  const s = (id, h1, extra = {}) => ({id, tokens: {'H1 size': h1}, ...extra});
  const out = consistency([s('a', '35px'), s('b', '35px'), s('c', '70px'), s('d', '—'), s('e', '90px', {ownUi: false})]);
  assert.deepEqual(out.rows[0], {name: 'H1 size', house: '35px', variants: 2, odd: ['c']});
  assert.equal(out.outliers, 1);
});

test('screen keys ignore ids and tickets but keep what picks a different screen', () => {
  assert.equal(screenKey('http://x/review?id=1&ticket=abc'), screenKey('http://x/review?ticket=zzz&id=2'));
  assert.notEqual(screenKey('http://x/imported-edit?id=1&page=a.html'), screenKey('http://x/imported-edit?id=1&page=b.html'));
});
