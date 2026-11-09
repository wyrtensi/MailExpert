import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedHoverActions, allowedSwipeAction, isTrashFolderEntry, movableFolders, withoutDeleteChoices,
} from './deletePolicy.js';

const folders = [
  { path: 'INBOX', name: 'INBOX', delimiter: '/' },
  { path: '[Gmail]/Bin', name: 'Bin', delimiter: '/', special_use: '\\Trash' },
  { path: 'Trash', name: 'Trash', delimiter: '/' },
  { path: 'Projects/Trash', name: 'Trash', delimiter: '/' },
  { path: 'Projects', name: 'Projects', delimiter: '/' },
];

test('a \\Trash folder and a top-level Trash name are Trash', () => {
  assert.equal(isTrashFolderEntry(folders[1]), true);
  assert.equal(isTrashFolderEntry(folders[2]), true);
  assert.equal(isTrashFolderEntry(folders[3]), false);
  assert.equal(isTrashFolderEntry(folders[4]), false);
});

test('a mapped Trash folder is the only Trash', () => {
  assert.equal(isTrashFolderEntry(folders[4], { trash: 'Projects' }), true);
  assert.equal(isTrashFolderEntry(folders[2], { trash: 'Projects' }), false);
});

test('move destinations keep Trash while deleting is on', () => {
  assert.equal(movableFolders(folders, true), folders);
});

test('move destinations drop Trash while deleting is off', () => {
  assert.deepEqual(movableFolders(folders, false).map(f => f.path), ['INBOX', 'Projects/Trash', 'Projects']);
});

test('the hover delete action goes while deleting is off', () => {
  assert.deepEqual(allowedHoverActions(['markRead', 'delete', 'move'], true), ['markRead', 'delete', 'move']);
  assert.deepEqual(allowedHoverActions(['markRead', 'delete', 'move'], false), ['markRead', 'move']);
});

test('a delete swipe does nothing while deleting is off', () => {
  assert.equal(allowedSwipeAction('delete', false), 'disabled');
  assert.equal(allowedSwipeAction('delete', true), 'delete');
  assert.equal(allowedSwipeAction('archive', false), 'archive');
});

test('choice lists drop delete items while deleting is off', () => {
  const items = [{ id: 'star' }, { id: 'delete' }, { id: 'trash' }];
  assert.equal(withoutDeleteChoices(items, true), items);
  assert.deepEqual(withoutDeleteChoices(items, false), [{ id: 'star' }, { id: 'trash' }]);
  assert.deepEqual(withoutDeleteChoices(items, false, ['trash']), [{ id: 'star' }, { id: 'delete' }]);
  assert.deepEqual(withoutDeleteChoices(['archive', 'delete'], false), ['archive']);
});
