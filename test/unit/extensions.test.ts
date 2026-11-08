import { describe, expect, it } from 'vitest';
import { extensionChanges, sortExtensions } from '@/lib/extensions';
import type { Extension } from '@/lib/report';

const e = (name: string, version: string | null, active: boolean | null = true, type: string | null = 'plugin'): Extension => ({ name, version, active, type });

describe('extensionChanges', () => {
  it('sums up the first list', () => {
    expect(extensionChanges(null, [e('Polylang', '3.7')])).toEqual(['1 installed plugin sent']);
    expect(extensionChanges(null, [])).toEqual(['0 installed plugins sent']);
  });

  it('lists added, updated, (de)activated and removed plugins', () => {
    const before = [e('Polylang', '3.6'), e('WPML', '4.6'), e('Akismet', '5.3', false), e('Yoast SEO', '24.0')];
    const after = [e('polylang', '3.7'), e('Akismet', '5.3', true), e('Yoast SEO', '24.0'), e('Redirection', '5.5', false)];
    expect(extensionChanges(before, after)).toEqual(['Akismet activated', 'polylang 3.6 → 3.7', '+ Redirection 5.5 (inactive)', '− WPML']);
  });

  it('reports nothing for the same list in another order', () => {
    expect(extensionChanges([e('A', '1'), e('B', '2')], [e('B', '2'), e('A', '1')])).toEqual([]);
  });

  it('caps long lists', () => {
    const after = Array.from({ length: 10 }, (_, n) => e(`P${n}`, '1'));
    const out = extensionChanges([], after);
    expect(out).toHaveLength(6);
    expect(out[5]).toBe('5 more changes');
  });
});

describe('sortExtensions', () => {
  it('puts active ones first, then type and name', () => {
    const list = [e('b', '1', false), e('Twenty', '1', true, 'theme'), e('a', '1', true), e('C', '1', true)];
    expect(sortExtensions(list).map((x) => x.name)).toEqual(['a', 'C', 'Twenty', 'b']);
  });
});
