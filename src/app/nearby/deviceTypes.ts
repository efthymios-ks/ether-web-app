import type { DevicePlatform, DeviceType } from '../../core/deviceInfo.js';
import { h } from '../dom.js';
import { ICONS } from '../icons.js';

// How a nearby device's type reads and looks. The type comes from the other device, so unknown ones fall back.

const DEVICE_TYPE_LABELS: Readonly<Record<DeviceType, string>> = Object.freeze({
    phone: 'Phone',
    tablet: 'Tablet',
    desktop: 'Computer',
});

const DEVICE_TYPE_ICONS: Readonly<Record<DeviceType, string>> = Object.freeze({
    phone: ICONS.phone,
    tablet: ICONS.tablet,
    desktop: ICONS.desktop,
});

export function deviceTypeLabel(deviceType: DeviceType): string {
    return (DEVICE_TYPE_LABELS as Partial<Record<string, string>>)[deviceType] ?? 'Device';
}

// The tag beside a device's name: its platform, e.g. "iPad", or its type when an older build sent none.
export function devicePlatformLabel(device: {
    readonly deviceType: DeviceType;
    readonly platform?: DevicePlatform;
}): string {
    return device.platform ?? deviceTypeLabel(device.deviceType);
}

export function deviceTypeIcon(deviceType: DeviceType): HTMLElement {
    const icon = (DEVICE_TYPE_ICONS as Partial<Record<string, string>>)[deviceType] ?? ICONS.desktop;

    return h('span', { class: 'nearby-icon', html: icon, attrs: { 'aria-hidden': 'true' } });
}
