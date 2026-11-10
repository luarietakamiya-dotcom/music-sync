// Only fixed public enum values survive. Free-text explanations/errors may contain
// names now or in future modules, so replacing known filenames alone is insufficient.
const publicValues = new Set(['AUTO', 'IMPACT', 'LIVE', 'accepted', 'rejected', 'adjusted', 'unchanged', 'skipped', 'proposed', 'applied', 'reverted', 'stems', 'vocal-instrumental',
  'lead', 'backing', 'vocal', 'instrumental', 'drums', 'bass', 'guitar', 'keys', 'other', 'auto', 'youtube', 'streaming', 'cd', 'dynamic',
  'none', 'warm', 'clear', 'old-record', 'cassette', 'telephone', 'am-radio', 'next-room',
  'off', 'light', 'strong', 'gentle', 'standard', 'vivid', 'live-house', 'concert-hall', 'arena', 'intimate-room', 'small-hall',
  'eq', 'dc', 'balance', 'width', 'bass-center', 'dynamics', 'dynamic-eq', 'multiband', 'live',
  'Dry', 'Moderate', 'Wet', 'persistent', 'intermittent',
  'sub', 'low', 'lowMid', 'mid', 'upperMid', 'presence', 'high', 'air',
  'lowEndBuildup', 'muddiness', 'boxiness', 'harshness', 'brightness', 'dullness', 'lowDynamics', 'highDynamics', 'lowSpread', 'phaseRisk']);
const publicKeys = new Set(['status', 'mode', 'role', 'vocalRole', 'output', 'preset', 'intensity', 'venue', 'kind',
  'issue', 'targetIssue', 'temporal', 'band', 'ambienceClass', 'stage']);

/** For MusicSync-generated JSON reports: keep measurements and redact free text.
 * Does not mutate the report. Not a scrubber for arbitrary user-defined schema keys.
 */
export function anonymizeFinishingReport(report: object): unknown {
  const identities = new Map<string, string>();
  const alias = (value: string) => {
    if (!identities.has(value)) identities.set(value, `source-${identities.size + 1}`);
    return identities.get(value);
  };
  return JSON.parse(JSON.stringify(report, (key, value: unknown) => {
    if (key === 'processed' || key === 'audio' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined;
    if (typeof value !== 'string') return value;
    if (key === 'name' || key === 'id' || key === 'leadId' || key === 'instrumentalId') return alias(value);
    return publicKeys.has(key) && publicValues.has(value) ? value : '[redacted]';
  }));
}
