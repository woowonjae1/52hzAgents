import { test, expect } from '@playwright/test';
import { turnForWorkspace } from '../lib/agent-turn-event';

// Pure logic, no page: the relayed turn event must reach a store keyed by the
// route slug even though the row carries the workspace UUID.
const UUID = '2bc6345b-f42b-41cb-a08c-bd4b623bff1c';
const turn = { workspace_id: UUID, agent_name: 'a', channel_name: 'thread-1', state: 'running' };

test.describe('turnForWorkspace', () => {
  test('a relay tagged with the route slug is applied although the row holds the UUID', () => {
    expect(turnForWorkspace({ workspace: 'my-slug', turn }, 'my-slug')).toBe(turn);
  });

  test('a relay tagged with another workspace is dropped', () => {
    expect(turnForWorkspace({ workspace: 'other', turn }, 'my-slug')).toBeNull();
  });

  test('an untagged relay falls back to the row workspace_id', () => {
    expect(turnForWorkspace({ turn }, UUID)).toBe(turn);
    expect(turnForWorkspace({ turn }, 'my-slug')).toBeNull();
  });

  test('nothing to apply without a turn or a current workspace', () => {
    expect(turnForWorkspace(undefined, 'my-slug')).toBeNull();
    expect(turnForWorkspace({ workspace: 'my-slug' }, 'my-slug')).toBeNull();
    expect(turnForWorkspace({ workspace: 'my-slug', turn }, null)).toBeNull();
  });
});
