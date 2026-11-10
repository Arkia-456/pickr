import {afterEach, beforeAll, describe, expect, it} from 'vitest';
import Pickr from '../src/js/pickr';

const waitForInit = pickr => new Promise(resolve => pickr.on('init', resolve));

const createPickr = options => {
    const el = document.body.appendChild(document.createElement('div'));
    return Pickr.create({el, theme: 'classic', ...options});
};

describe('Pickr', () => {
    const instances = [];

    beforeAll(() => {

        // jsdom does not perform layout, pickr waits for the app to have a width before finishing setup
        Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
            configurable: true,
            get: () => 1
        });
    });

    afterEach(() => {
        instances.splice(0).forEach(pickr => pickr.destroyAndRemove());
        document.body.innerHTML = '';
    });

    it('applies the default color', async () => {
        const pickr = createPickr({default: '#ff0000'});
        instances.push(pickr);

        await waitForInit(pickr);
        expect(pickr.getColor().toHEXA().toString()).toBe('#FF0000');
        expect(pickr.getSelectedColor().toHEXA().toString()).toBe('#FF0000');
    });

    it('keeps a color set via setColor before initialization finished', async () => {
        const pickr = createPickr({default: '#ff0000'});
        instances.push(pickr);

        expect(pickr.setColor('#00ff00')).toBe(true);
        await waitForInit(pickr);
        expect(pickr.getColor().toHEXA().toString()).toBe('#00FF00');
        expect(pickr.getSelectedColor().toHEXA().toString()).toBe('#00FF00');
    });

    it('keeps a color cleared via setColor(null) before initialization finished', async () => {
        const pickr = createPickr({default: '#ff0000'});
        instances.push(pickr);

        expect(pickr.setColor(null)).toBe(true);
        await waitForInit(pickr);
        expect(pickr.getSelectedColor()).toBe(null);
    });

    describe('eyedropper', () => {
        afterEach(() => {
            delete window.EyeDropper;
        });

        const mockEyeDropper = open => {
            window.EyeDropper = class {
                open = open;
            };
        };

        it('falls back to picking from the page without the EyeDropper API', async () => {
            const pickr = createPickr({components: {interaction: {eyedropper: true}}});
            instances.push(pickr);
            await waitForInit(pickr);
            expect(pickr.getRoot().interaction.eyedropper.hidden).toBe(false);

            // Selection mode is active until cancelled
            const result = pickr.openEyeDropper();
            expect(document.documentElement.classList.contains('pcr-eyedropper-active')).toBe(true);

            window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
            expect(await result).toBe(false);
            expect(document.documentElement.classList.contains('pcr-eyedropper-active')).toBe(false);
        });

        it('shows the button only if enabled', async () => {
            const enabled = createPickr({components: {interaction: {eyedropper: true}}});
            const disabled = createPickr({components: {interaction: {input: true}}});
            instances.push(enabled, disabled);

            await Promise.all([waitForInit(enabled), waitForInit(disabled)]);
            expect(enabled.getRoot().interaction.eyedropper.hidden).toBe(false);
            expect(disabled.getRoot().interaction.eyedropper.hidden).toBe(true);
        });

        it('applies the picked color as opaque and emits change events', async () => {
            mockEyeDropper(async () => ({sRGBHex: '#1a2b3c'}));
            const pickr = createPickr({default: 'rgba(255, 0, 0, 0.5)', components: {interaction: {eyedropper: true}}});
            instances.push(pickr);
            await waitForInit(pickr);

            const sources = [];
            pickr.on('change', (color, source) => sources.push(source));
            pickr.on('changestop', source => sources.push(`stop:${source}`));

            expect(await pickr.openEyeDropper()).toBe(true);
            expect(pickr.getColor().toHEXA().toString()).toBe('#1A2B3C');
            expect(sources).toEqual(['eyedropper', 'stop:eyedropper']);

            // Picking doesn't save the color
            expect(pickr.getSelectedColor().toHEXA().toString()).toBe('#FF000080');
        });

        it('keeps the current color if cancelled', async () => {
            mockEyeDropper(async () => {
                throw new DOMException('The user canceled the selection.', 'AbortError');
            });

            const pickr = createPickr({default: '#ff0000', components: {interaction: {eyedropper: true}}});
            instances.push(pickr);
            await waitForInit(pickr);

            expect(await pickr.openEyeDropper()).toBe(false);
            expect(pickr.getColor().toHEXA().toString()).toBe('#FF0000');
        });
    });
});
