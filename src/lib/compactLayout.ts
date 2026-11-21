/**
 * Phone-sized screens, where the full toolbar would cover most of the board. Narrower than 640 px (phones held
 * upright) or shorter than 500 px (phones held sideways). Tablets (an iPad is 744+ px wide and 744+ px tall either way
 * up), Chromebooks and laptops are never compact.
 */
export const PHONE_MAX_WIDTH = 640;
export const PHONE_MAX_HEIGHT = 500;

export function isPhoneViewport(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return width < PHONE_MAX_WIDTH || height < PHONE_MAX_HEIGHT;
}
