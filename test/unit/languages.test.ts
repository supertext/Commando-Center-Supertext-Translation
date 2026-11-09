import { describe, expect, it } from 'vitest';
import { languageChanges, sortLanguages } from '../../src/lib/languages';
import { parseLanguages, parseReport } from '../../src/lib/report';

describe('parseLanguages', () => {
  it('keeps code and Supertext code as sent, drops what is malformed', () => {
    expect(
      parseLanguages([
        { code: ' de_CH ', supertext: ' de-CH ' },
        { code: 'zh_Hans_CN', supertext: 'zh-Hans' },
        { code: 'gsw', supertext: 'gsw-u-sd-chzh' },
        { code: 'en_IE', supertext: null },
        { code: 'fr', supertext: 'not a code!' },
        { code: 'DE_ch', supertext: 'de-DE' }, // duplicate code
        { code: '', supertext: 'it-IT' },
        { code: '<script>', supertext: 'it-IT' },
        'de',
        null,
      ]),
    ).toEqual([
      { code: 'de_CH', supertext: 'de-CH' },
      { code: 'zh_Hans_CN', supertext: 'zh-Hans' },
      { code: 'gsw', supertext: 'gsw-u-sd-chzh' },
      { code: 'en_IE', supertext: null },
      { code: 'fr', supertext: null },
    ]);
  });
  it('treats a non-list as absent and caps at 100', () => {
    expect(parseLanguages(undefined)).toBeNull();
    expect(parseLanguages({ de: 'de-CH' })).toBeNull();
    expect(parseLanguages(Array.from({ length: 150 }, (_, i) => ({ code: `l${i}`, supertext: 'de' })))).toHaveLength(100);
  });
  it('is part of the report', () => {
    const r = parseReport({
      schema: 1,
      event: 'languages',
      site_url: 'https://www.kunde.ch',
      plugin: { name: 'p', version: '1.0.0' },
      system: { name: 'WordPress' },
      languages: [{ code: 'de_CH', supertext: 'de-CH' }],
    });
    expect(r.ok && r.report.languages).toEqual([{ code: 'de_CH', supertext: 'de-CH' }]);
  });
});

describe('languageChanges', () => {
  const a = [
    { code: 'de_CH', supertext: 'de-CH' },
    { code: 'en_IE', supertext: null },
  ];
  it('first list', () => expect(languageChanges(null, a)).toEqual(['2 languages sent']));
  it('added, removed, mapped', () => {
    expect(
      languageChanges(a, [
        { code: 'de_CH', supertext: 'de-DE' },
        { code: 'en_IE', supertext: 'en-GB' },
        { code: 'fr', supertext: 'fr-FR' },
      ]),
    ).toEqual(['de_CH: de-CH → de-DE', 'en_IE: not mapped → en-GB', '+ fr → fr-FR']);
    expect(languageChanges(a, [a[0]])).toEqual(['− en_IE']);
    expect(languageChanges(a, [...a])).toEqual([]);
  });
  it('sorts by code', () => expect(sortLanguages([a[1], a[0]]).map((l) => l.code)).toEqual(['de_CH', 'en_IE']));
});
