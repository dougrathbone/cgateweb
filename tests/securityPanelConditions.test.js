const {
    PANEL_CONDITIONS,
    PANEL_TROUBLE_CONDITIONS,
    PANEL_TROUBLE_VERBS,
    PANEL_TROUBLE_DETAIL_VERBS,
    CLEARED_ON_DISARM,
    CLEARED_ON_ARM,
    describePanelCondition
} = require('../src/securityPanelConditions');

// This registry exists so one condition's wire verbs, HA metadata and log
// wording live in one record. These tests are the guard rail: before it existed
// the same knowledge sat in seven tables across four modules, and adding an
// eighth condition while missing one table failed silently (an entity named
// `undefined`, or a log line showing the raw condition id).
describe('securityPanelConditions', () => {
    it('gives every condition the fields all four consumers need', () => {
        for (const condition of PANEL_CONDITIONS) {
            expect(typeof condition.id).toBe('string');
            expect(typeof condition.name).toBe('string');
            expect(typeof condition.deviceClass).toBe('string');
            expect(typeof condition.raisedText).toBe('string');
            expect(typeof condition.clearedText).toBe('string');
            // Every condition must be reachable from the wire: either it names
            // its own sense, or it carries it in a _raised/_cleared argument.
            expect(Boolean(condition.raiseVerb || condition.detailVerb)).toBe(true);
        }
    });

    it('has no duplicate condition ids', () => {
        expect(new Set(PANEL_TROUBLE_CONDITIONS).size).toBe(PANEL_TROUBLE_CONDITIONS.length);
    });

    it('maps no verb to two different conditions', () => {
        const verbs = [...PANEL_TROUBLE_VERBS.keys(), ...PANEL_TROUBLE_DETAIL_VERBS.keys()];
        expect(new Set(verbs).size).toBe(verbs.length);
    });

    it('derives the verb maps from the records', () => {
        expect(PANEL_TROUBLE_VERBS.get('mains_failure')).toEqual({ condition: 'mains', active: true });
        expect(PANEL_TROUBLE_VERBS.get('mains_restored')).toEqual({ condition: 'mains', active: false });
        // panic accepts two inferred clear spellings, neither of them captured.
        expect(PANEL_TROUBLE_VERBS.get('panic_off')).toEqual({ condition: 'panic', active: false });
        expect(PANEL_TROUBLE_VERBS.get('panic_cleared')).toEqual({ condition: 'panic', active: false });
        expect(PANEL_TROUBLE_DETAIL_VERBS.get('line_cut_alarm')).toBe('line');
    });

    it('derives the derived-clear lists from the records', () => {
        expect(CLEARED_ON_DISARM.sort()).toEqual(['arm_failed', 'fire', 'panic']);
        expect(CLEARED_ON_ARM).toEqual(['arm_failed']);
    });

    it('gives every condition some route back to clear, so none can latch on forever', () => {
        // The failure this guards against: a condition that can be raised but has
        // no clear verb and no derived clear would pin its sensor ON until the
        // bridge restarts. panic deliberately has both an inferred clear verb and
        // a derived clear -- we never captured panic_off, so we accept it if it
        // arrives and fall back to the disarm clear if it does not.
        for (const condition of PANEL_CONDITIONS) {
            const clearable = Boolean(condition.clearVerb)
                || Boolean(condition.detailVerb)   // carries its own _cleared form
                || condition.clearedOnDisarm === true
                || condition.clearedOnArm === true;
            expect({ id: condition.id, clearable }).toEqual({ id: condition.id, clearable: true });
        }
    });

    it('describes both senses of a condition', () => {
        expect(describePanelCondition('mains', true)).toBe('Mains power failure');
        expect(describePanelCondition('mains', false)).toBe('Mains power restored');
    });

    it('falls back to the raw id for an unknown condition', () => {
        expect(describePanelCondition('not_a_condition', true)).toBe('not_a_condition');
    });
});
