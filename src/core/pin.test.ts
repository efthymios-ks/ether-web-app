import { describe, expect, it } from 'vitest';
import { isValidPin, PIN_FORMAT_TEXT, toPinDigits } from './pin.js';

describe('isValidPin', () => {
    it.each([
        ['4 digits', '1234', true],
        ['8 digits', '00000000', true],
        ['3 digits', '123', false],
        ['9 digits', '123456789', false],
        ['a space', '12 34', false],
        ['a letter', '123a', false],
        ['other digits than ASCII', '١٢٣٤', false],
        ['a number', 1234, false],
        ['null', null, false],
    ] as const)('takes %s: %s', (_, value, expected) => {
        // Act
        const isValid = isValidPin(value);

        // Assert
        expect(isValid).toBe(expected);
    });

    it('says what a PIN must be', () => {
        // Act & Assert
        expect(PIN_FORMAT_TEXT).toBe('Use 4 to 8 digits.');
    });
});

describe('toPinDigits', () => {
    it.each([
        ['keeps digits', '0042', '0042'],
        ['drops spaces, dashes and letters', ' 12-3a4 ', '1234'],
        ['keeps the first 8 digits', '1234 5678 9', '12345678'],
        ['leaves nothing of no digits', 'PIN', ''],
    ])('%s', (_, text, expected) => {
        // Act
        const digits = toPinDigits(text);

        // Assert
        expect(digits).toBe(expected);
    });
});
