import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from './validate.js';

const search = {
  name: 'search_things',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, maxResults: { type: 'number' }, pageToken: { type: 'string' } },
    required: ['query'],
  },
};
const bare = { name: 'list_all', inputSchema: { type: 'object', properties: {} } };

test('declared arguments pass, including when optional ones are omitted', () => {
  assert.equal(validateArgs(search, { query: 'x', maxResults: 5 }), undefined);
  assert.equal(validateArgs(search, { query: 'x' }), undefined);
  assert.equal(validateArgs(bare, {}), undefined);
});

test('a required argument given as null or empty string counts as provided', () => {
  assert.equal(validateArgs(search, { query: null }), undefined);
  assert.equal(validateArgs(search, { query: '' }), undefined);
});

test('an unknown argument fails and the message lists what the tool accepts', () => {
  assert.throws(() => validateArgs(search, { query: 'x', limit: 5 }), {
    message: 'Unknown parameter: limit. search_things accepts: query, maxResults, pageToken.',
  });
});

test('snake_case and kebab-case spellings of a declared name get a did-you-mean hint', () => {
  assert.throws(() => validateArgs(search, { query: 'x', max_results: 5 }), {
    message: 'Unknown parameter: max_results (did you mean maxResults?). search_things accepts: query, maxResults, pageToken.',
  });
  assert.throws(() => validateArgs(search, { query: 'x', 'page-token': 'abc' }), {
    message: /page-token \(did you mean pageToken\?\)/,
  });
  assert.throws(() => validateArgs(search, { query: 'x', MAXRESULTS: 5 }), {
    message: /MAXRESULTS \(did you mean maxResults\?\)/,
  });
});

test('several unknown arguments are reported together, in plural', () => {
  assert.throws(() => validateArgs(search, { query: 'x', q: 1, limit: 2 }), {
    message: 'Unknown parameters: q, limit. search_things accepts: query, maxResults, pageToken.',
  });
});

test('a missing required argument fails, in singular or plural', () => {
  assert.throws(() => validateArgs(search, {}), { message: 'Missing required parameter: query.' });
  const two = { name: 't', inputSchema: { type: 'object', properties: { a: {}, b: {} }, required: ['a', 'b'] } };
  assert.throws(() => validateArgs(two, {}), { message: 'Missing required parameters: a, b.' });
});

test('unknown arguments are reported before missing ones', () => {
  assert.throws(() => validateArgs(search, { Query: 'x' }), { message: /^Unknown parameter: Query \(did you mean query\?\)/ });
});

test('the hint only fires for the same name in another case or separator style, not for prefixes', () => {
  assert.throws(() => validateArgs(search, { query: 'x', q: 1 }), { message: /^Unknown parameter: q\. / });
});

test('a tool with no parameters says so when given any', () => {
  assert.throws(() => validateArgs(bare, { anything: 1 }), {
    message: 'Unknown parameter: anything. list_all accepts: (none).',
  });
});

test('a tool with no inputSchema is treated as taking nothing', () => {
  assert.equal(validateArgs({ name: 'n' }, {}), undefined);
  assert.throws(() => validateArgs({ name: 'n' }, { x: 1 }), { message: /accepts: \(none\)/ });
});
