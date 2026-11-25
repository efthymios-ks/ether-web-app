import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: 'logic',
                    include: [
                        'src/core/**/*.test.ts',
                        'src/network/**/*.test.ts',
                        'src/discovery/**/*.test.ts',
                        'src/client/**/*.test.ts',
                        'src/media/**/*.test.ts',
                        'src/qr/**/*.test.ts',
                        'src/platform/**/*.test.ts',
                        'scripts/**/*.test.mjs',
                        'relay/**/*.test.ts',
                    ],
                    environment: 'node',
                },
            },
            {
                test: {
                    name: 'ui',
                    include: ['src/app/**/*.test.ts'],
                    environment: 'happy-dom',
                    testTimeout: 15_000,
                },
            },
        ],
    },
});
