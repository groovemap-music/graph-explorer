#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const exploreDir = resolve(dirname(modulePath), '..');
const repoRoot = resolve(exploreDir, '..');
const defaultManifestPath = join(exploreDir, 'vendor-assets.json');
const defaultVendorDir = join(exploreDir, 'static', 'vendor');

const REQUIRED_PACKAGES = new Set([
    '@fontsource/inter',
    '@fontsource/jetbrains-mono',
    '@fontsource/space-grotesk',
    'alpinejs',
    'd3',
    'dompurify',
    'marked',
    'material-symbols',
    'plotly.js-dist-min',
    'qrcodejs',
]);

const GENERATED_FILES = new Set(['ASSET_LICENSES.json', 'THIRD_PARTY_NOTICES.md']);

function invariant(condition, message) {
    if (!condition) throw new Error(message);
}

function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function sorted(values) {
    return [...values].sort();
}

function walkFiles(root) {
    if (!existsSync(root)) return [];
    const files = [];
    function walk(directory) {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) walk(path);
            if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
        }
    }
    walk(root);
    return sorted(files);
}

function packageLicenses(packageMetadata) {
    if (typeof packageMetadata.license === 'string') return [packageMetadata.license];
    if (Array.isArray(packageMetadata.licenses)) {
        return packageMetadata.licenses.map((license) => license.type).filter(Boolean);
    }
    return [];
}

function licenseSourcePath(asset, root = repoRoot) {
    if (asset.license_source.scope === 'package') {
        return join(root, 'explore', 'node_modules', asset.package, asset.license_source.path);
    }
    invariant(asset.license_source.scope === 'repository', `unsupported license source scope for ${asset.package}`);
    return join(root, asset.license_source.path);
}

function loadAndValidateManifest(manifestPath = defaultManifestPath, root = repoRoot) {
    const manifest = readJson(manifestPath);
    invariant(manifest.schema === 1, 'vendor asset manifest schema must be 1');
    invariant(Array.isArray(manifest.assets), 'vendor asset manifest must contain an assets array');

    const packages = manifest.assets.map((asset) => asset.package);
    invariant(new Set(packages).size === packages.length, 'vendor asset manifest contains duplicate packages');
    invariant(
        JSON.stringify(sorted(packages)) === JSON.stringify(sorted(REQUIRED_PACKAGES)),
        'vendor asset manifest must classify every required JavaScript and font package',
    );

    const outputs = manifest.assets.flatMap((asset) => asset.outputs);
    invariant(new Set(outputs).size === outputs.length, 'runtime asset outputs must map to exactly one package');
    const licenseDestinations = manifest.assets.map((asset) => asset.license_destination);
    invariant(new Set(licenseDestinations).size === licenseDestinations.length, 'license destinations must be unique');

    for (const asset of manifest.assets) {
        invariant(asset.outputs.length > 0, `${asset.package} has no classified runtime outputs`);
        invariant(asset.declared_license.includes(asset.selected_license), `${asset.package} selected license is not offered by its package metadata`);

        const packageRoot = join(root, 'explore', 'node_modules', asset.package);
        const packageMetadata = readJson(join(packageRoot, 'package.json'));
        invariant(packageMetadata.name === asset.package, `unexpected package name for ${asset.package}`);
        invariant(packageMetadata.version === asset.version, `unexpected package version for ${asset.package}`);
        invariant(packageLicenses(packageMetadata).includes(asset.declared_license), `unexpected declared license for ${asset.package}`);

        const sourcePath = licenseSourcePath(asset, root);
        invariant(statSync(sourcePath).isFile(), `license source is missing for ${asset.package}`);
        invariant(sha256(readFileSync(sourcePath)) === asset.license_source.sha256, `license source changed for ${asset.package}`);
    }
    return manifest;
}

export function assertAssetInventory(expectedFiles, actualFiles) {
    const expected = new Set(expectedFiles);
    const actual = new Set(actualFiles);
    const missing = sorted(expected).filter((path) => !actual.has(path));
    const unclassified = sorted(actual).filter((path) => !expected.has(path));
    invariant(missing.length === 0, `missing classified runtime assets: ${missing.join(', ')}`);
    invariant(unclassified.length === 0, `unclassified runtime assets: ${unclassified.join(', ')}`);
}

function renderedManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

function renderedNotices(manifest) {
    const rows = manifest.assets.map((asset) =>
        `| [${asset.name}](${asset.homepage}) | \`${asset.package}\` | \`${asset.version}\` | \`${asset.selected_license}\` | [license text](${asset.license_destination}) |`,
    );
    return [
        '# Third-party notices',
        '',
        'The runtime assets listed below are third-party works distributed under their own licenses. Those rights are separate from GrooveMap Graph Explorer\'s AGPL-3.0-only license and from any optional first-party commercial terms.',
        '',
        '| Component | Package | Version | Selected license | Required text |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
        '',
        'DOMPurify is distributed under the Apache-2.0 option offered by its `(MPL-2.0 OR Apache-2.0)` package declaration.',
        '',
    ].join('\n');
}

export function validateVendorAssets({ root = repoRoot, vendorDir = defaultVendorDir, manifestPath = defaultManifestPath } = {}) {
    const manifest = loadAndValidateManifest(manifestPath, root);
    const licenseDestinations = new Set(manifest.assets.map((asset) => asset.license_destination));
    const runtimeFiles = walkFiles(vendorDir).filter((path) => !GENERATED_FILES.has(path) && !licenseDestinations.has(path));
    assertAssetInventory(manifest.assets.flatMap((asset) => asset.outputs), runtimeFiles);

    for (const asset of manifest.assets) {
        const destination = join(vendorDir, asset.license_destination);
        invariant(existsSync(destination), `vendored license text is missing for ${asset.package}`);
        invariant(sha256(readFileSync(destination)) === asset.license_source.sha256, `vendored license text changed for ${asset.package}`);
    }

    invariant(readFileSync(join(vendorDir, 'ASSET_LICENSES.json'), 'utf8') === renderedManifest(manifest), 'generated asset license map is stale');
    invariant(readFileSync(join(vendorDir, 'THIRD_PARTY_NOTICES.md'), 'utf8') === renderedNotices(manifest), 'generated third-party notices are stale');
    return manifest;
}

export function buildVendorNotices({ root = repoRoot, vendorDir = defaultVendorDir, manifestPath = defaultManifestPath } = {}) {
    const manifest = loadAndValidateManifest(manifestPath, root);
    mkdirSync(join(vendorDir, 'licenses'), { recursive: true });
    for (const asset of manifest.assets) {
        writeFileSync(join(vendorDir, asset.license_destination), readFileSync(licenseSourcePath(asset, root)));
    }
    writeFileSync(join(vendorDir, 'ASSET_LICENSES.json'), renderedManifest(manifest));
    writeFileSync(join(vendorDir, 'THIRD_PARTY_NOTICES.md'), renderedNotices(manifest));
    validateVendorAssets({ root, vendorDir, manifestPath });
}

if (resolve(process.argv[1] ?? '') === resolve(modulePath)) {
    const command = process.argv[2];
    if (command === 'build') buildVendorNotices();
    else if (command === 'check') validateVendorAssets();
    else throw new Error('usage: vendor-licenses.mjs build|check');
}
