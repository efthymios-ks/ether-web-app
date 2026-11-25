// The PIN that lets a nearby device connect without an Accept on this one (SP-09 to SP-12): 4 to 8 digits,
// kept in the settings only. Nearby presence says no more than that a device has one, and a request proves it
// knows the PIN without sending it (src/discovery/nearbyPin.ts).

export const MIN_PIN_DIGITS = 4;
export const MAX_PIN_DIGITS = 8;

const PIN_PATTERN = new RegExp(`^[0-9]{${MIN_PIN_DIGITS},${MAX_PIN_DIGITS}}$`);
const NOT_DIGITS = /[^0-9]/g;

export const PIN_FORMAT_TEXT = `Use ${MIN_PIN_DIGITS} to ${MAX_PIN_DIGITS} digits.`;

export function isValidPin(value: unknown): value is string {
    return typeof value === 'string' && PIN_PATTERN.test(value);
}

// What a PIN field keeps of what was typed or pasted: the ASCII digits, at most 8 of them.
export function toPinDigits(text: string): string {
    return text.replace(NOT_DIGITS, '').slice(0, MAX_PIN_DIGITS);
}
