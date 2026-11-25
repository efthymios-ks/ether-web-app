import { h } from './dom.js';

// Copies plain text: the async clipboard first, then a hidden field and the copy command, which still works
// in most browsers when the async clipboard is refused. Resolves to false when neither worked.
export async function copyTextAsync(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);

        return true;
    } catch {
        return copyWithCommand(text);
    }
}

function copyWithCommand(text: string): boolean {
    const field = h('textarea', { class: 'copy-buffer', attrs: { 'readonly': true, 'aria-hidden': 'true', 'tabindex': '-1' } });
    field.value = text;
    document.body.append(field);
    field.select();
    try {
        return typeof document.execCommand === 'function' && document.execCommand('copy');
    } catch {
        return false;
    } finally {
        field.remove();
    }
}
