export interface SeparationDevice {userAgent:string;platform:string;maxTouchPoints:number;mobile?:boolean}
/** Desktop mode on an iPad is still a mobile device with a constrained browser process. */
export function isDesktopSeparationDevice(device:SeparationDevice):boolean{
  return device.mobile!==true&&!/Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(device.userAgent)&&
    !(device.platform==='MacIntel'&&device.maxTouchPoints>1);
}
export function separationAvailableOnDevice():boolean{
  const nav=navigator as Navigator&{userAgentData?:{mobile?:boolean}};
  return isDesktopSeparationDevice({userAgent:nav.userAgent,platform:nav.platform,maxTouchPoints:nav.maxTouchPoints,mobile:nav.userAgentData?.mobile});
}
