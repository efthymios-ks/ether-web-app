import { toPinDigits } from '../../core/pin.js';
import { h } from '../dom.js';

// A PIN field for the Set a PIN and Enter X's PIN sheets: a numeric keypad on phones (inputmode and pattern),
// and digits only, at most 8: anything else typed or pasted is dropped as it comes in,
// so "1234 5678" pastes whole.

export interface PinInputOptions {
    readonly label: string;
    readonly placeholder: string;
    // one-time-code lets a phone offer a code it just received; off for a new PIN.
    readonly autocomplete: 'off' | 'one-time-code';
    // The ids of the sheet's help text and error line.
    readonly describedBy: string;
    readonly onInput?: () => void;
}

export function createPinInput(options: PinInputOptions): HTMLInputElement {
    const input = h('input', {
        class: 'text-input pin-input',
        attrs: {
            'type': 'text',
            'inputmode': 'numeric',
            'pattern': '[0-9]*',
            'autocomplete': options.autocomplete,
            'autocapitalize': 'off',
            'spellcheck': 'false',
            'enterkeyhint': 'done',
            'placeholder': options.placeholder,
            'aria-label': options.label,
            'aria-describedby': options.describedBy,
        },
        dataset: { role: 'pin' },
    });
    input.addEventListener('input', () => {
        const digits = toPinDigits(input.value);
        if (input.value !== digits) {
            input.value = digits;
        }

        options.onInput?.();
    });

    return input;
}
