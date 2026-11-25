import type { DeviceInfo } from '../core/deviceInfo.js';
import { AndroidPlatform } from './androidPlatform.js';
import { DesktopPlatform } from './desktopPlatform.js';
import { IosPlatform } from './iosPlatform.js';
import type { Platform } from './platform.js';

// Order is priority; the first matching family wins and desktop takes the rest.
const PLATFORM_FACTORIES: ReadonlyArray<{ matches(info: DeviceInfo): boolean; create(info: DeviceInfo): Platform }> = [
    {
        matches: info => info.os === 'iOS' || info.os === 'iPadOS',
        create: info => new IosPlatform(info),
    },
    {
        matches: info => info.os === 'Android',
        create: info => new AndroidPlatform(info),
    },
];

export function createPlatform(info: DeviceInfo): Platform {
    const factory = PLATFORM_FACTORIES.find(item => item.matches(info));

    return factory?.create(info) ?? new DesktopPlatform(info);
}
