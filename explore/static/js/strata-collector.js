/**
 * Strata collector machine (ADR 0016 section 4, vocabulary A).
 *
 * A release is `none`, `wanted`, `owned`, or `wanted + owned`. The machine is
 * display-only: every edge is observed at Discogs sync and none is a control.
 * The only authored actions are "Record an observation" (owned copy only) and
 * "Sync now"; nothing here writes a wantlist or a collection.
 *
 * Colors are never defined here. Each state resolves to the promoted design
 * token `--groovemap-state-collector-<state>-<light|dark>` (brand/tokens.css).
 */

export const CollectorState = Object.freeze({
    NONE: 'none',
    WANTED: 'wanted',
    OWNED: 'owned',
    WANTED_OWNED: 'wanted-owned',
});

export const COLLECTOR_STATES = Object.freeze(Object.values(CollectorState));

const STATE_LABELS = Object.freeze({
    [CollectorState.NONE]: 'none',
    [CollectorState.WANTED]: 'wanted',
    [CollectorState.OWNED]: 'owned',
    [CollectorState.WANTED_OWNED]: 'wanted + owned',
});

/** Where an observation came from; only Discogs sync may move the machine. */
export const OBSERVED_SOURCE = 'discogs-sync';

export const ObservationType = Object.freeze({
    WANT_OBSERVED: 'want-observed',
    WANT_DROPPED: 'want-dropped',
    OWN_OBSERVED: 'own-observed',
    OWN_DROPPED: 'own-dropped',
});

/** The authored actions on a release node. Everything else is rejected. */
export const CollectorAction = Object.freeze({
    RECORD_OBSERVATION: 'record-observation',
    SYNC_NOW: 'sync-now',
});

export const THEMES = Object.freeze(['light', 'dark']);

export class AuthoredChangeError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthoredChangeError';
    }
}

const FLAGS = Object.freeze({
    [CollectorState.NONE]: { wanted: false, owned: false },
    [CollectorState.WANTED]: { wanted: true, owned: false },
    [CollectorState.OWNED]: { wanted: false, owned: true },
    [CollectorState.WANTED_OWNED]: { wanted: true, owned: true },
});

function assertState(state) {
    if (!COLLECTOR_STATES.includes(state)) {
        throw new RangeError(`unknown collector state: ${String(state)}`);
    }
}

export function stateLabel(state) {
    assertState(state);
    return STATE_LABELS[state];
}

export function hasWant(state) {
    assertState(state);
    return FLAGS[state].wanted;
}

export function hasOwn(state) {
    assertState(state);
    return FLAGS[state].owned;
}

/** The state for an observed pair of flags. */
export function stateFromFlags({ wanted = false, owned = false } = {}) {
    if (wanted) return owned ? CollectorState.WANTED_OWNED : CollectorState.WANTED;
    return owned ? CollectorState.OWNED : CollectorState.NONE;
}

/**
 * The collector state shown for a release, or null when none is shown.
 * A MusicBrainz-only release has no Discogs wantlist or collection, so it
 * carries no collector state at all (which is not the same as `none`).
 */
export function releaseState(release) {
    if (release?.identity === 'musicbrainz_only') return null;
    return stateFromFlags(release);
}

/**
 * A master or credit rolls up from its releases at read time: wanted if any
 * shown release is wanted, owned if any is owned. Releases with no state are
 * ignored; a parent with no stateful release has no state.
 */
export function rollUp(states) {
    let seen = false;
    let wanted = false;
    let owned = false;
    for (const state of states) {
        if (state === null || state === undefined) continue;
        assertState(state);
        seen = true;
        wanted ||= FLAGS[state].wanted;
        owned ||= FLAGS[state].owned;
    }
    return seen ? stateFromFlags({ wanted, owned }) : null;
}

/**
 * Apply one observed edge. Only `OBSERVED_SOURCE` events are accepted; an
 * authored change of want or own is rejected. Re-observing a state that
 * already holds is a no-op, because a sync reports what Discogs has.
 */
export function transition(state, observation) {
    assertState(state);
    if (observation?.source !== OBSERVED_SOURCE) {
        throw new AuthoredChangeError('want and own change only by observation at Discogs sync');
    }
    const { wanted, owned } = FLAGS[state];
    switch (observation.type) {
        case ObservationType.WANT_OBSERVED:
            return stateFromFlags({ wanted: true, owned });
        case ObservationType.WANT_DROPPED:
            return stateFromFlags({ wanted: false, owned });
        case ObservationType.OWN_OBSERVED:
            return stateFromFlags({ wanted, owned: true });
        case ObservationType.OWN_DROPPED:
            return stateFromFlags({ wanted, owned: false });
        default:
            throw new AuthoredChangeError(`not an observation: ${String(observation.type)}`);
    }
}

/** Build an observation as the sync pipeline would emit it. */
export function observed(type) {
    return { type, source: OBSERVED_SOURCE };
}

/**
 * Guard an authored action against a release's state. Returns the action when
 * allowed and throws `AuthoredChangeError` otherwise: "Sync now" is always
 * allowed, "Record an observation" needs an owned copy, and any want or own
 * write (add to wantlist, mark as collected, and so on) is refused.
 */
export function guardAction(state, action) {
    assertState(state);
    if (action === CollectorAction.SYNC_NOW) return action;
    if (action === CollectorAction.RECORD_OBSERVATION) {
        if (!FLAGS[state].owned) {
            throw new AuthoredChangeError('an observation is recorded on an owned copy only');
        }
        return action;
    }
    throw new AuthoredChangeError(`GrooveMap does not author want or own changes: ${String(action)}`);
}

/** Non-throwing form of `guardAction`, for enabling or disabling controls. */
export function canPerform(state, action) {
    try {
        guardAction(state, action);
        return true;
    } catch (error) {
        if (error instanceof AuthoredChangeError) return false;
        throw error;
    }
}

/** `dark` when the root carries the `.dark` class (see theme.js), else `light`. */
export function activeTheme(root = globalThis.document?.documentElement) {
    return root?.classList?.contains('dark') ? 'dark' : 'light';
}

/** The promoted token name for a state in a theme. */
export function stateTokenName(state, theme) {
    assertState(state);
    if (!THEMES.includes(theme)) throw new RangeError(`unknown theme: ${String(theme)}`);
    return `--groovemap-state-collector-${state}-${theme}`;
}

function readComputedToken(name) {
    return getComputedStyle(globalThis.document.documentElement).getPropertyValue(name).trim();
}

/**
 * Resolve a state's color from the promoted tokens for a theme (default: the
 * active one). `readToken` maps a custom-property name to its value and
 * defaults to the computed style of the document root. A missing token throws
 * rather than falling back to a color defined here.
 */
export function stateColor(state, { theme = activeTheme(), readToken = readComputedToken } = {}) {
    const name = stateTokenName(state, theme);
    const value = readToken(name);
    if (!value) throw new Error(`design token ${name} is not defined; is brand/tokens.css loaded?`);
    return value;
}
