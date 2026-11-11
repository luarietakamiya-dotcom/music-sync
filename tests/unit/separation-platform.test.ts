import {describe,expect,it} from 'vitest';
import {isDesktopSeparationDevice} from '../../apps/web/src/separation-platform';
describe('PC-only AI separation',()=>{
  it.each([
    {userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153',platform:'Win32',maxTouchPoints:0},
    {userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153',platform:'Win32',maxTouchPoints:10},
    {userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605',platform:'MacIntel',maxTouchPoints:0},
  ])('allows desktop including a Windows touch laptop',device=>{expect(isDesktopSeparationDevice(device)).toBe(true);});
  it.each([
    {userAgent:'Mozilla/5.0 (Linux; Android 16) Chrome/153',platform:'Linux',maxTouchPoints:5},
    {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18) Safari/605',platform:'iPhone',maxTouchPoints:5},
    {userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605',platform:'MacIntel',maxTouchPoints:5},
    {userAgent:'Generic',platform:'Linux',maxTouchPoints:0,mobile:true},
  ])('does not start large models on phones or an iPad in desktop mode',device=>{expect(isDesktopSeparationDevice(device)).toBe(false);});
});
