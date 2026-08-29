import { describe, expect, it } from 'vitest';

import { assertAssetInventory } from '../scripts/vendor-licenses.mjs';


describe('vendored asset classification', () => {
    it('fails when a classified runtime asset is missing', () => {
        expect(() => assertAssetInventory(['d3.min.js', 'marked.mjs'], ['d3.min.js'])).toThrow(
            'missing classified runtime assets: marked.mjs',
        );
    });

    it('fails when a runtime asset is unclassified', () => {
        expect(() => assertAssetInventory(['d3.min.js'], ['d3.min.js', 'unknown.js'])).toThrow(
            'unclassified runtime assets: unknown.js',
        );
    });
});
