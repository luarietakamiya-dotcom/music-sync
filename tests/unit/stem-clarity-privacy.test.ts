import { expect, it } from 'vitest';
import { anonymizeFinishingReport } from '@music-sync/core';
it('preserves anonymized lead and accompaniment report references without leaking identities', () => {
  const report = { clarity: {leadId:'private-lead',status:'applied'},
    masking:{instrumentalId:'private-guitar'}, tracks:[{id:'private-lead',vocalRole:'lead'},{id:'private-guitar'}] };
  const original=JSON.stringify(report), redacted=JSON.stringify(anonymizeFinishingReport(report));
  const result=JSON.parse(redacted);
  expect(redacted).not.toContain('private');
  expect(result.clarity.leadId).toBe(result.tracks[0].id);
  expect(result.masking.instrumentalId).toBe(result.tracks[1].id);
  expect(result.tracks[0].vocalRole).toBe('lead');
  expect(JSON.stringify(report)).toBe(original);
});
