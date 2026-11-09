/** Transient owner evidence for one explicitly selected physical copy. No catalog/state writes. */
class CopyEvidence {
    constructor({ container, api, auth, isCurrent = () => true, readOnly = false, onSelection = () => {}, onStatus = () => {} }) {
        Object.assign(this, { container, api, auth, isCurrent, readOnly, onSelection, onStatus });
        this.token = auth?.getToken?.();
        this.generation = 0;
        this.destroyed = false;
        this.selectedCopyId = null;
        this.copies = [];
        this.timelineRequest = 0;
        this.doc = container.ownerDocument;
        this.container.setAttribute('aria-label', 'Physical copy evidence');
    }

    element(tag, text, className) {
        const element = this.doc.createElement(tag);
        if (text != null) element.textContent = text;
        if (className) element.className = className;
        return element;
    }

    current(generation) {
        return !this.destroyed && generation === this.generation && this.token === this.auth?.getToken?.() && this.isCurrent();
    }

    destroy() {
        this.destroyed = true;
        this.generation += 1;
        this.selectedCopyId = null;
        this.container.replaceChildren();
    }

    async loadItem(itemId) {
        const generation = ++this.generation;
        this.selectedCopyId = null;
        this.onSelection(null);
        this.container.textContent = 'Loading physical copies…';
        try {
            const result = await this.api.getOwnedCopies(this.token, itemId);
            if (!this.current(generation)) return;
            if (!result?.ok || !Array.isArray(result.body?.copies)) {
                this.container.textContent = 'Physical copies unavailable.';
                return;
            }
            this.showCopies(result.body.copies, { complete: result.body.truncated === false, truncated: result.body.truncated === true });
        } catch {
            if (this.current(generation)) this.container.textContent = 'Physical copies unavailable.';
        }
    }

    showCopies(copies, { complete = false, truncated = false } = {}) {
        this.generation += 1;
        this.selectedCopyId = null;
        this.copies = Array.isArray(copies) ? copies.filter(copy => typeof copy?.id === 'string' && copy.id).slice(0, 50) : [];
        this.container.replaceChildren();
        const heading = this.element('h5', 'Physical copies');
        const limit = truncated || (Array.isArray(copies) && copies.length > 50);
        const scope = this.element('p', limit ? 'Copy list truncated; more copies may exist.' : complete ? 'All copies in this item read are listed.' : 'Synced-copy projection; copy-list completeness is unknown.');
        this.container.append(heading, scope);
        if (!this.copies.length) {
            this.container.append(this.element('p', copies == null ? 'Physical copies unavailable.' : 'No physical copies in this read.'));
            this.onSelection(null);
            return;
        }
        const label = this.element('label', 'Physical copy');
        const select = this.element('select', null, 'form-input-dark copy-select');
        select.setAttribute('aria-label', 'Physical copy');
        const prompt = this.element('option', 'Choose a physical copy');
        prompt.value = '';
        select.append(prompt);
        for (const copy of this.copies) {
            const option = this.element('option', `${copy.id} · acquired: ${copy.acquired_at ?? 'unknown'}`);
            option.value = copy.id;
            select.append(option);
        }
        label.append(select);
        this.identity = this.element('p', 'Choose a physical copy to read or record evidence.');
        this.timeline = this.element('div', null, 'copy-timeline');
        this.timeline.setAttribute('role', 'status');
        this.timeline.setAttribute('aria-live', 'polite');
        this.formHost = this.element('div');
        this.container.append(label, this.identity, this.timeline, this.formHost);
        select.addEventListener('change', () => this.selectCopy(select.value));
        this.select = select;
        this.onSelection(null);
        if (complete && !limit && this.copies.length === 1) {
            select.value = this.copies[0].id;
            this.selectCopy(select.value);
        }
    }

    async selectCopy(copyId) {
        const generation = ++this.generation;
        this.selectedCopyId = this.copies.some(copy => copy.id === copyId) ? copyId : null;
        this.formHost.replaceChildren();
        this.timeline.replaceChildren();
        this.identity.textContent = this.selectedCopyId ? `Selected physical copy: ${this.selectedCopyId}` : 'Choose a physical copy to read or record evidence.';
        this.onSelection(this.selectedCopyId);
        if (!this.selectedCopyId) return;
        await this.loadTimeline(generation);
    }

    async loadTimeline(generation = this.generation) {
        const copyId = this.selectedCopyId;
        const request = ++this.timelineRequest;
        this.timeline.textContent = 'Loading observations…';
        try {
            const result = await this.api.getCopyObservations(this.token, copyId);
            if (!this.current(generation) || copyId !== this.selectedCopyId || request !== this.timelineRequest) return;
            if (!result?.ok || !Array.isArray(result.body?.observations)) {
                this.timeline.textContent = 'Observations unavailable.';
                return;
            }
            this.timeline.replaceChildren(this.element('p', 'Observation timeline (all recorded history). Observed time and recorded time are separate.'));
            if (!result.body.observations.length) this.timeline.append(this.element('p', 'No observations recorded for this copy.'));
            const list = this.element('ol');
            for (const observation of result.body.observations) {
                const row = this.element('li');
                row.append(this.element('p', `${observation.kind ?? 'unknown'}: ${observation.value ?? ''}`),
                    this.element('p', `Source: ${observation.source ?? 'unknown'} · Confidence: ${observation.confidence ?? 'unknown'}`),
                    this.element('p', `Observed at: ${observation.observed_at ?? 'unknown'} · Recorded at: ${observation.created_at ?? 'unknown'}`));
                list.append(row);
            }
            this.timeline.append(list);
        } catch {
            if (this.current(generation) && copyId === this.selectedCopyId && request === this.timelineRequest) this.timeline.textContent = 'Observations unavailable.';
        }
    }

    openForm() {
        if (this.readOnly || !this.selectedCopyId || !this.current(this.generation)) return null;
        const form = this.element('form', null, 'strata-observation');
        form.setAttribute('aria-label', 'Record an observation about your copy');
        const kindLabel = this.element('label', 'What', 'strata-field');
        const kind = this.element('select', null, 'form-input-dark');
        for (const [id, name] of [['matrix', 'Matrix / runout'], ['grading', 'Grading'], ['purchase_price', 'Purchase price'], ['note', 'Note']]) {
            const option = this.element('option', name); option.value = id; kind.append(option);
        }
        kindLabel.append(kind);
        const valueLabel = this.element('label', 'Observed', 'strata-field');
        const value = this.element('input', null, 'form-input-dark');
        value.required = true;
        valueLabel.append(value);
        const save = this.element('button', 'Save observation', 'strata-action');
        save.type = 'submit';
        const status = this.element('p'); status.setAttribute('role', 'status');
        form.append(kindLabel, valueLabel, save, status);
        const generation = this.generation;
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (!this.current(generation)) return;
            save.disabled = true;
            await this.record({ kind: kind.value, value: value.value }, status);
            if (this.current(generation)) save.disabled = false;
        });
        this.formHost.replaceChildren(form);
        value.focus();
        return form;
    }

    async record({ kind, value }, status = null) {
        const generation = this.generation;
        const copyId = this.selectedCopyId;
        const text = String(value || '').trim();
        const say = message => { if (status) status.textContent = message; this.onStatus(message); };
        if (!this.current(generation) || this.readOnly || !copyId) return false;
        if (!text) { say('Write what you observed first.'); return false; }
        let result;
        try { result = await this.api.createObservation(this.token, copyId, { kind, value: text, source: 'user' }); }
        catch { result = null; }
        if (!this.current(generation) || copyId !== this.selectedCopyId) return false;
        // Unknown and foreign copies have the same unavailable presentation. No server detail leaks.
        say(result?.ok ? 'Observation recorded.' : 'The observation could not be recorded.');
        if (result?.ok) await this.loadTimeline(generation);
        return !!result?.ok;
    }
}
window.CopyEvidence = CopyEvidence;
