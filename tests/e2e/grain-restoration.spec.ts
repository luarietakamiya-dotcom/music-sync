import { expect, test } from '@playwright/test';
import { wav } from '../helpers/audio';
import { readFile } from 'node:fs/promises';
function noisySecond(rate: number) {
    let seed = 31, low = 0;
    const pcm = Float32Array.from({ length: rate }, (_, i) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const x = (seed / 2 ** 32 - 0.5) * 0.16;
        low += 0.28 * (x - low);
        const t = i / rate, envelope = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 3 * t));
        return envelope * (0.11 * Math.sin(2 * Math.PI * 220 * t) + 0.04 * Math.sin(2 * Math.PI * 3300 * t) + 0.024 * Math.sin(2 * Math.PI * 4400 * t) + x - low);
    });
    return new Uint8Array(wav({ sampleRate: rate, channels: [pcm] }));
}
async function upload(page: import('@playwright/test').Page, seconds: number, rate: number) {
    const second = noisySecond(rate), header = second.slice(0, 44), payload = second.slice(44);
    const view = new DataView(header.buffer);
    view.setUint32(4, 36 + payload.length * seconds, true);
    view.setUint32(40, payload.length * seconds, true);
    await page.locator('#dropzone').evaluate((zone, fixture) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([Uint8Array.from(fixture.header), ...Array(fixture.seconds).fill(Uint8Array.from(fixture.payload))], 'phrased-grain.wav', { type: 'audio/wav' }));
        zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    }, { header: Array.from(header), payload: Array.from(payload), seconds });
}
test('musical grain is measured and adopted by automatic finishing with its report and matched playback', async ({ page }) => {
    await page.goto('/');
    await upload(page, 3, 48000);
    await expect(page.locator('#mode-AUTO')).toBeEnabled();
    await page.locator('#grain-mode').selectOption('strong');
    await page.locator('#treble-repair').selectOption('off');
    await page.locator('#mode-AUTO').click();
    await expect(page.locator('#finish-applied-summary')).toContainText('ジャリつきのスペクトル補修');
    await expect(page.locator('#match-toggle')).toBeChecked();
    await page.locator('#advanced-settings').evaluate((el: HTMLDetailsElement) => { el.open = true; });
    const download = page.waitForEvent('download');
    await page.locator('#finish-report-button').click();
    const report = JSON.parse(await readFile((await (await download).path())!, 'utf8'));
    expect(report.grain.status).toBe('applied');
    expect(report.grain.seconds).toBeGreaterThan(1);
});
test('file-backed grain restoration keeps a ten-minute source aligned and creates a verified candidate', async ({ page }) => {
    test.setTimeout(360000);
    await page.goto('/');
    await upload(page, 601, 16000);
    await expect(page.locator('#duration')).toContainText('10:01', { timeout: 90000 });
    await page.locator('#grain-mode').selectOption('strong');
    await page.locator('#treble-repair').selectOption('off');
    await page.locator('#mode-AUTO').click();
    await expect(page.locator('#finish-applied-summary')).toContainText('ジャリつきのスペクトル補修', { timeout: 240000 });
    await expect(page.locator('#match-toggle')).toBeChecked();
    await expect(page.locator('#wav-button')).toBeEnabled();
    await expect(page.locator('#duration')).toContainText('10:01');
});
