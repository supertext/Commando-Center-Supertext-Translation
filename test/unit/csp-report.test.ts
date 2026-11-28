import { describe, expect, it } from 'vitest';
import { cspReportSites, parseCspReports } from '../../src/lib/csp-report';

const sites = new Set(['wix-production.up.railway.app', 'integrations.supertext.com']);

describe('CSP reports', () => {
  it('reads the Reporting API format and keeps no query strings or fragments', () => {
    const v = parseCspReports(
      [
        {
          type: 'csp-violation',
          url: 'https://wix-production.up.railway.app/?instance=secret.data',
          body: {
            documentURL: 'https://wix-production.up.railway.app/settings?instance=secret.data#x',
            blockedURL: 'https://evil.example/x.js?token=1',
            effectiveDirective: 'script-src-elem',
            disposition: 'enforce',
          },
        },
        { type: 'deprecation', body: {} },
      ],
      sites,
    );
    expect(v).toEqual([{ site: 'wix-production.up.railway.app', page: '/settings', directive: 'script-src-elem', blocked: 'https://evil.example', enforced: true }]);
    expect(JSON.stringify(v)).not.toContain('secret');
  });

  it('reads the report-uri format, inline and report-only', () => {
    const v = parseCspReports(
      { 'csp-report': { 'document-uri': 'https://integrations.supertext.com/en/support', 'blocked-uri': 'inline', 'violated-directive': "script-src 'self'", disposition: 'report' } },
      sites,
    );
    expect(v).toEqual([{ site: 'integrations.supertext.com', page: '/en/support', directive: 'script-src', blocked: 'inline', enforced: false }]);
  });

  it('drops other hosts, odd schemes and junk', () => {
    expect(parseCspReports({ 'csp-report': { 'document-uri': 'https://other.example/', 'blocked-uri': 'inline' } }, sites)).toEqual([]);
    expect(parseCspReports({ 'csp-report': { 'document-uri': 'javascript:alert(1)' } }, sites)).toEqual([]);
    expect(parseCspReports('nonsense', sites)).toEqual([]);
    expect(parseCspReports([{ type: 'csp-violation', body: { documentURL: 'https://integrations.supertext.com/', blockedURL: 'data:image/png;base64,AAA', effectiveDirective: '<script>' } }], sites))
      .toEqual([{ site: 'integrations.supertext.com', page: '/', directive: 'unknown', blocked: 'data', enforced: true }]);
  });

  it('takes the sites from COMMANDO_CSP_SITES, else the built-in list', () => {
    expect(cspReportSites('a.example, B.example')).toEqual(new Set(['a.example', 'b.example']));
    expect(cspReportSites('').has('pluginhealth.supertext.com')).toBe(true);
  });
});
