export interface RepairControls {
  grain?: 'off' | 'light' | 'standard' | 'strong'; amount?: number; repeatGrain?: boolean;
  hissHz?: number; hissDb?: number; clarityDb?: number; autoClarity?: boolean;
}
export function bounded(value: number, low: number, high: number) {
  if (!Number.isFinite(value) || value < low || value > high) throw new Error('設定値が対応範囲外です。');
  return value;
}
/** Preserve 35 as the existing mastering behaviour. All outcomes still pass the normal gate. */
export function liftAllowance(normal: number, aggression = 35) {
  bounded(aggression, 0, 100);
  return aggression <= 35 ? normal * aggression / 35 : normal + (6 - normal) * (aggression - 35) / 65;
}
