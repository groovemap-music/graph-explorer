import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    AuthoredChangeError,
    COLLECTOR_STATES,
    CollectorAction,
    CollectorState,
    OBSERVED_SOURCE,
    ObservationType,
    THEMES,
    activeTheme,
    canPerform,
    guardAction,
    hasOwn,
    hasWant,
    observed,
    releaseState,
    rollUp,
    stateColor,
    stateFromFlags,
    stateLabel,
    stateTokenName,
    transition,
} from '../static/js/strata-collector.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const brandDir = path.join(here, '..', 'static', 'brand');
const tokensCss = fs.readFileSync(path.join(brandDir, 'tokens.css'), 'utf8');
const sourceJson = JSON.parse(fs.readFileSync(path.join(brandDir, 'source.json'), 'utf8'));

function tokenTable(css) {
    const table = new Map();
    for (const [, name, value] of css.matchAll(/(--[\w-]+):\s*([^;]+);/g)) table.set(name, value.trim());
    return table;
}

const tokens = tokenTable(tokensCss);
const readToken = (name) => tokens.get(name) ?? '';

const { NONE, WANTED, OWNED, WANTED_OWNED } = CollectorState;
const { WANT_OBSERVED, WANT_DROPPED, OWN_OBSERVED, OWN_DROPPED } = ObservationType;

describe('collector states', () => {
    it('are exactly none, wanted, owned, and wanted + owned', () => {
        expect(COLLECTOR_STATES).toEqual([NONE, WANTED, OWNED, WANTED_OWNED]);
        expect(COLLECTOR_STATES.map(stateLabel)).toEqual(['none', 'wanted', 'owned', 'wanted + owned']);
    });

    it('map flags to a state and back', () => {
        expect(stateFromFlags()).toBe(NONE);
        expect(stateFromFlags({ wanted: true })).toBe(WANTED);
        expect(stateFromFlags({ owned: true })).toBe(OWNED);
        expect(stateFromFlags({ wanted: true, owned: true })).toBe(WANTED_OWNED);
        for (const state of COLLECTOR_STATES) {
            expect(stateFromFlags({ wanted: hasWant(state), owned: hasOwn(state) })).toBe(state);
        }
    });

    it('reject an unknown state', () => {
        expect(() => stateLabel('borrowed')).toThrow(RangeError);
        expect(() => hasWant(undefined)).toThrow(RangeError);
        expect(() => hasOwn('')).toThrow(RangeError);
    });
});

describe('observed transitions', () => {
    const cases = [
        [NONE, WANT_OBSERVED, WANTED],
        [NONE, OWN_OBSERVED, OWNED],
        [NONE, WANT_DROPPED, NONE],
        [NONE, OWN_DROPPED, NONE],
        [WANTED, WANT_OBSERVED, WANTED],
        [WANTED, WANT_DROPPED, NONE],
        [WANTED, OWN_OBSERVED, WANTED_OWNED],
        [WANTED, OWN_DROPPED, WANTED],
        [OWNED, WANT_OBSERVED, WANTED_OWNED],
        [OWNED, WANT_DROPPED, OWNED],
        [OWNED, OWN_OBSERVED, OWNED],
        [OWNED, OWN_DROPPED, NONE],
        [WANTED_OWNED, WANT_OBSERVED, WANTED_OWNED],
        [WANTED_OWNED, WANT_DROPPED, OWNED],
        [WANTED_OWNED, OWN_OBSERVED, WANTED_OWNED],
        [WANTED_OWNED, OWN_DROPPED, WANTED],
    ];

    it('covers every state against every observation', () => {
        expect(cases).toHaveLength(COLLECTOR_STATES.length * Object.keys(ObservationType).length);
    });

    it.each(cases)('%s + %s -> %s', (from, type, to) => {
        expect(transition(from, observed(type))).toBe(to);
    });

    it('tags observations with the Discogs sync source', () => {
        expect(observed(WANT_OBSERVED)).toEqual({ type: WANT_OBSERVED, source: OBSERVED_SOURCE });
    });

    it('rejects an authored change of want or own', () => {
        for (const state of COLLECTOR_STATES) {
            for (const type of Object.values(ObservationType)) {
                expect(() => transition(state, { type })).toThrow(AuthoredChangeError);
                expect(() => transition(state, { type, source: 'user' })).toThrow(AuthoredChangeError);
            }
        }
        expect(() => transition(NONE, undefined)).toThrow(AuthoredChangeError);
    });

    it('rejects an observation type it does not know', () => {
        expect(() => transition(NONE, observed('add-to-wantlist'))).toThrow(AuthoredChangeError);
    });

    it('rejects an unknown current state', () => {
        expect(() => transition('borrowed', observed(WANT_OBSERVED))).toThrow(RangeError);
    });
});

describe('authored action guard', () => {
    it('always allows "Sync now"', () => {
        for (const state of COLLECTOR_STATES) {
            expect(guardAction(state, CollectorAction.SYNC_NOW)).toBe(CollectorAction.SYNC_NOW);
        }
    });

    it('allows "Record an observation" on an owned copy only', () => {
        expect(canPerform(OWNED, CollectorAction.RECORD_OBSERVATION)).toBe(true);
        expect(canPerform(WANTED_OWNED, CollectorAction.RECORD_OBSERVATION)).toBe(true);
        expect(canPerform(NONE, CollectorAction.RECORD_OBSERVATION)).toBe(false);
        expect(canPerform(WANTED, CollectorAction.RECORD_OBSERVATION)).toBe(false);
        expect(() => guardAction(WANTED, CollectorAction.RECORD_OBSERVATION)).toThrow(AuthoredChangeError);
    });

    it('rejects any authored want or own change in every state', () => {
        const authored = [
            'add-to-wantlist',
            'remove-from-wantlist',
            'mark-as-collected',
            'remove-from-collection',
            'set-wanted',
            'set-owned',
            undefined,
        ];
        for (const state of COLLECTOR_STATES) {
            for (const action of authored) {
                expect(() => guardAction(state, action)).toThrow(AuthoredChangeError);
                expect(canPerform(state, action)).toBe(false);
            }
        }
    });

    it('still reports an unknown state as a programming error', () => {
        expect(() => canPerform('borrowed', CollectorAction.SYNC_NOW)).toThrow(RangeError);
    });
});

describe('release state and roll-up', () => {
    it('reads a Discogs release from its observed flags', () => {
        expect(releaseState({ wanted: true, owned: false, identity: 'discogs_only' })).toBe(WANTED);
        expect(releaseState({ wanted: false, owned: false, identity: 'linked' })).toBe(NONE);
        expect(releaseState({ wanted: true, owned: true })).toBe(WANTED_OWNED);
    });

    it('shows no state for a MusicBrainz-only release', () => {
        expect(releaseState({ wanted: true, owned: true, identity: 'musicbrainz_only' })).toBeNull();
    });

    it('rolls a master or credit up from its releases', () => {
        expect(rollUp([NONE, NONE])).toBe(NONE);
        expect(rollUp([NONE, WANTED])).toBe(WANTED);
        expect(rollUp([OWNED, NONE])).toBe(OWNED);
        expect(rollUp([WANTED, OWNED])).toBe(WANTED_OWNED);
        expect(rollUp([WANTED_OWNED, NONE])).toBe(WANTED_OWNED);
    });

    it('ignores releases without a state and shows none when all lack one', () => {
        expect(rollUp([null, OWNED, undefined])).toBe(OWNED);
        expect(rollUp([null, null])).toBeNull();
        expect(rollUp([])).toBeNull();
    });

    it('rejects an unknown state in a roll-up', () => {
        expect(() => rollUp([OWNED, 'borrowed'])).toThrow(RangeError);
    });
});

describe('state colors', () => {
    it('name the promoted collector tokens for each theme', () => {
        expect(stateTokenName(WANTED_OWNED, 'dark')).toBe('--groovemap-state-collector-wanted-owned-dark');
        expect(stateTokenName(NONE, 'light')).toBe('--groovemap-state-collector-none-light');
        expect(() => stateTokenName(NONE, 'sepia')).toThrow(RangeError);
        expect(() => stateTokenName('borrowed', 'dark')).toThrow(RangeError);
    });

    it('are defined by the promoted tokens.css, whose provenance is recorded', () => {
        expect(sourceJson.assets['tokens.css']).toBeTruthy();
        for (const state of COLLECTOR_STATES) {
            for (const theme of THEMES) {
                expect(tokens.has(stateTokenName(state, theme))).toBe(true);
            }
        }
    });

    it('resolve every state and theme to the token value, with no value defined in the module', () => {
        for (const state of COLLECTOR_STATES) {
            for (const theme of THEMES) {
                expect(stateColor(state, { theme, readToken })).toBe(tokens.get(stateTokenName(state, theme)));
            }
        }
        const source = fs.readFileSync(path.join(here, '..', 'static', 'js', 'strata-collector.js'), 'utf8');
        expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(source).not.toMatch(/\b(?:rgb|hsl)a?\(/);
    });

    it('differ per state within a theme', () => {
        for (const theme of THEMES) {
            const colors = COLLECTOR_STATES.map((state) => stateColor(state, { theme, readToken }));
            expect(new Set(colors).size).toBe(COLLECTOR_STATES.length);
        }
    });

    it('fail loudly when a token is missing instead of falling back', () => {
        expect(() => stateColor(OWNED, { theme: 'dark', readToken: () => '' })).toThrow(/tokens\.css/);
    });

    describe('active theme', () => {
        it('is dark only when the root carries .dark, as theme.js sets it', () => {
            const root = document.createElement('html');
            expect(activeTheme(root)).toBe('light');
            root.classList.add('dark');
            expect(activeTheme(root)).toBe('dark');
        });

        it('defaults to the document root', () => {
            document.documentElement.classList.remove('dark');
            expect(activeTheme()).toBe('light');
            document.documentElement.classList.add('dark');
            try {
                expect(activeTheme()).toBe('dark');
                expect(stateColor(OWNED, { readToken })).toBe(tokens.get(stateTokenName(OWNED, 'dark')));
            } finally {
                document.documentElement.classList.remove('dark');
            }
        });

        it('reads custom properties from the computed style by default', () => {
            const name = stateTokenName(WANTED, 'light');
            document.documentElement.style.setProperty(name, tokens.get(name));
            try {
                expect(stateColor(WANTED, { theme: 'light' })).toBe(tokens.get(name));
            } finally {
                document.documentElement.style.removeProperty(name);
            }
        });
    });
});
