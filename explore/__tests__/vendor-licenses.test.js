import { describe, expect, it } from 'vitest';

import { assertAssetInventory, assertSourceDigests } from '../scripts/vendor-licenses.mjs';


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


describe('vendored source digests', () => {
    const source = { package: 'three', version: '0.186.1', files: { 'three.module.js': 'aa', 'three.core.js': 'bb' } };

    it('passes when every recorded digest matches', () => {
        expect(() => assertSourceDigests(source, { 'three.module.js': 'aa', 'three.core.js': 'bb' }, 'vendored copy of')).not.toThrow();
    });

    it('fails when a file drifted from its recorded digest', () => {
        expect(() => assertSourceDigests(source, { 'three.module.js': 'aa', 'three.core.js': 'cc' }, 'vendored copy of')).toThrow(
            'vendored copy of three.core.js drifted from three@0.186.1 source.json',
        );
    });

    it('fails when a recorded file is missing', () => {
        expect(() => assertSourceDigests(source, { 'three.module.js': 'aa' }, 'vendored copy of')).toThrow(
            'vendored copy of is missing three.core.js',
        );
    });
});
