/**
 * Writing a form control's `disabled` state without needlessly blurring it.
 *
 * Disabling a focused control blurs it, and re-enabling does **not** give focus
 * back -- `document.activeElement` does not return to it. Verified in Chromium:
 * focus a button, set `disabled = true` then `disabled = false`, and a
 * subsequent Space produces no click at all.
 *
 * The edit panel in this sample is re-rendered by background realtime events
 * and rewrites every control's `disabled` flag each time, so an idempotent
 * re-render -- by far the common case -- used to be able to take the keyboard
 * away from a user mid-edit for no reason.
 *
 * Writing only on an actual change removes that entirely: assigning a control
 * the value it already has cannot blur it.
 *
 * This does not, and deliberately should not, try to hand focus back after a
 * *genuine* disable/enable cycle. Deciding whether focus still belongs to the
 * control, or to whatever took it while the control was unusable, is a real
 * design question for this panel -- see honua-io/honua-sdk-js#1333.
 */

export type EditControl = HTMLButtonElement | HTMLInputElement | HTMLSelectElement;

/** Assign `disabled` only when it actually changes, so re-renders do not blur. */
export function setControlDisabled(element: EditControl, disabled: boolean): void {
  if (element.disabled === disabled) return;
  element.disabled = disabled;
}
