import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {perceptualFixture} from '../fixtures/perceptual';
import {wav} from '../helpers/audio';

test('AUTO explains decisions and exports valid perceptual/objective evidence without requiring Advanced',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await page.locator('#file-input').setInputFiles({name:'muddy-fixture.wav',mimeType:'audio/wav',buffer:Buffer.from(wav(perceptualFixture('muddy'),32,true))});
  await expect(page.locator('#mode-AUTO')).toBeEnabled();const a=await page.locator('#a-lufs').innerText();await page.locator('#mode-AUTO').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');
  await expect(page.locator('#finish-explanation')).toContainText('見送り');await expect(page.locator('#match-toggle')).toBeChecked();
  await expect(page.locator('#advanced-settings')).not.toHaveAttribute('open','');
  await page.getByText('Advanced Settings',{exact:true}).click();
  for(const heading of ['Detected Issues','Processing Decisions','Skipped Processing','Quality Evaluation'])await expect(page.locator('#finish-details')).toContainText(heading);
  const event=page.waitForEvent('download');await page.locator('#finish-report-button').click();const download=await event;
  const report=JSON.parse(await readFile((await download.path())!,'utf8'));
  expect(report.perceptual.bands.lowMid.mean).toBeGreaterThan(0.5);expect(report.attempts.length).toBeLessThanOrEqual(3);
  expect(report.attempts.at(-1).objectiveQuality.accepted).toBe(true);expect(report.attempts[0].mix.perceptual.detectedIssues.some((i:{issue:string})=>i.issue==='muddiness')).toBe(true);
  await expect(page.locator('#a-lufs')).toHaveText(a);expect(errors).toEqual([]);
  await page.screenshot({path:'test-results/phase7-advanced.png',fullPage:true});
});
test('mobile keeps simple controls and reduces ambience for a wet fixture',async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  await page.locator('#file-input').setInputFiles({name:'wet-fixture.wav',mimeType:'audio/wav',buffer:Buffer.from(wav(perceptualFixture('wet'),32,true))});
  await expect(page.locator('#mode-LIVE')).toBeEnabled();await page.locator('#mode-LIVE').click();
  await expect(page.locator('#finish-explanation')).toContainText('候補を用意しました');await expect(page.locator('#match-toggle')).toBeChecked();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/phase7-mobile.png',fullPage:true});
  await page.getByText('Advanced Settings',{exact:true}).click();await expect(page.locator('#finish-details')).toContainText('"Wet"');
});
