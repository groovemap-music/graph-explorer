/**
 * Shared media-taxonomy label helpers.
 *
 * Catalog API reports media by canonical id only: `/api/collection/media`
 * returns family counts as bare ids, and a release row's `media` block names a
 * family and a medium by id. Medium labels ship with the endpoint's `mediums`
 * list; family display names do not, so they live here — one map shared by the
 * gap filter and the search facet, so a family is spelled the same way in both.
 */
(function initMediaTaxonomy() {
    'use strict';

    const FAMILY_LABELS = {
        vinyl: 'Vinyl',
        shellac: 'Shellac',
        grooved_other: 'Other grooved',
        tape: 'Tape',
        optical: 'Optical',
        digital: 'Digital',
        video: 'Video',
        other: 'Other',
    };

    /**
     * Best-effort display name for an id the taxonomy map does not cover —
     * a family added upstream before this UI learns its name, or a medium id
     * missing from the endpoint's label list.
     * @param {string} id - Canonical snake_case taxonomy id
     * @returns {string} Human-readable fallback label
     */
    function humanize(id) {
        if (!id || typeof id !== 'string') return '';
        const spaced = id.replace(/_/g, ' ').trim();
        if (!spaced) return '';
        return spaced.charAt(0).toUpperCase() + spaced.slice(1);
    }

    /**
     * Display name for a media family id.
     * @param {string} id - Family id (vinyl, tape, optical, ...)
     * @returns {string} Family label
     */
    function familyLabel(id) {
        return FAMILY_LABELS[id] || humanize(id);
    }

    window.mediaTaxonomy = { FAMILY_LABELS, familyLabel, humanize };
})();
