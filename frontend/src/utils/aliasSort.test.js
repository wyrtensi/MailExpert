import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sortAliasesByName } from './aliasSort.js';

const emails = (list) => list.map((a) => a.email);

test('sorts aliases by name, case-insensitive', () => {
  const sorted = sortAliasesByName([
    { id: '1', name: 'roman Sipok', email: 'roman@example.com' },
    { id: '2', name: 'Anna Berg', email: 'anna@example.com' },
    { id: '3', name: 'boris Lee', email: 'boris@example.com' },
    { id: '4', name: 'Zoe Hart', email: 'zoe@example.com' },
  ]);
  assert.deepEqual(emails(sorted), [
    'anna@example.com', 'boris@example.com', 'roman@example.com', 'zoe@example.com',
  ]);
});

test('the same name is ordered by email', () => {
  const sorted = sortAliasesByName([
    { id: '1', name: 'Support', email: 'support-us@example.com' },
    { id: '2', name: 'support', email: 'Support-eu@example.com' },
    { id: '3', name: 'Support', email: 'support-asia@example.com' },
  ]);
  assert.deepEqual(emails(sorted), [
    'support-asia@example.com', 'Support-eu@example.com', 'support-us@example.com',
  ]);
});

test('an alias without a name sorts by the local part of its address', () => {
  const sorted = sortAliasesByName([
    { id: '1', name: 'Mark Stone', email: 'mark@example.com' },
    { id: '2', name: '', email: 'events@example.com' },
    { id: '3', name: null, email: 'Office@example.com' },
    { id: '4', name: '  ', email: 'zeta@example.com' },
    { id: '5', name: 'Diana Ross', email: 'diana@example.com' },
  ]);
  assert.deepEqual(emails(sorted), [
    'diana@example.com', 'events@example.com', 'mark@example.com', 'Office@example.com',
    'zeta@example.com',
  ]);
});

test('returns a new array and leaves the input alone', () => {
  const input = [
    { id: '1', name: 'B', email: 'b@example.com' },
    { id: '2', name: 'A', email: 'a@example.com' },
  ];
  const sorted = sortAliasesByName(input);
  assert.notEqual(sorted, input);
  assert.deepEqual(emails(input), ['b@example.com', 'a@example.com']);
});

test('no aliases → an empty list', () => {
  assert.deepEqual(sortAliasesByName(undefined), []);
  assert.deepEqual(sortAliasesByName(null), []);
  assert.deepEqual(sortAliasesByName([]), []);
});

// Every sender picker that lists aliases (`alias:<id>:<account>` option values) goes through the
// one sort, so the From lists and the settings list show the same order.
test('every alias option list is sorted with sortAliasesByName', () => {
  for (const file of ['../components/ComposeModal.jsx', '../components/AdminPanel.jsx']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const optionLists = source.split('value={`alias:${').length - 1;
    const sorted = source.split('sortAliasesByName(').length - 1;
    assert.ok(optionLists > 0, `${file}: no alias options found`);
    assert.ok(sorted >= optionLists, `${file}: ${optionLists} alias option lists, ${sorted} sorted`);
  }
});
