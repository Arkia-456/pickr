/**
 * Eyedropper with a pixel-level magnifier.
 *
 * Uses the native EyeDropper API if available (Chromium-based browsers), which can pick from anywhere
 * on the screen. Otherwise (Firefox, Safari) falls back to picking from images, canvases and videos
 * displayed in the page. Those must be same-origin (or served with CORS headers), otherwise the browser
 * doesn't allow reading their pixels.
 */

// Amount of source-pixels visible in the magnifier (should be odd to have a center pixel)
const LOUPE_PIXELS = 11;

// Size of a single magnified pixel in css pixels
const LOUPE_ZOOM = 11;

const LOUPE_SIZE = LOUPE_PIXELS * LOUPE_ZOOM;

const ACTIVE_CLASS = 'pcr-eyedropper-active';

export const DEFAULT_TARGETS = 'img, canvas, video';

const hasNative = () => typeof window !== 'undefined' && 'EyeDropper' in window;

const abortError = () => new DOMException('The user canceled the selection.', 'AbortError');

const toHex = (r, g, b) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;

/**
 * @returns {boolean} If the eyedropper can be used in this environment.
 */
export const isSupported = () => typeof window !== 'undefined' && typeof document !== 'undefined';

/**
 * Lets the user pick a color, must be called from a user gesture.
 * @param signal Optional AbortSignal to cancel the selection.
 * @param targets Elements which can be picked from if the native eyedropper is not available,
 * either a selector or a function receiving an element and returning a boolean.
 * @returns {Promise<{sRGBHex: string}>} Rejects if cancelled.
 */
export const pick = ({signal, targets = DEFAULT_TARGETS} = {}) => {
    return hasNative() ?
        new window.EyeDropper().open({signal}) :
        pickFromPage(signal, targets);
};

/**
 * Returns all elements at the given point, including those inside open shadow roots.
 */
function elementsFromPoint(root, x, y, result = []) {
    for (const el of root.elementsFromPoint(x, y)) {
        if (el.shadowRoot && el.shadowRoot !== root) {
            elementsFromPoint(el.shadowRoot, x, y, result);
        }

        if (!result.includes(el)) {
            result.push(el);
        }
    }

    return result;
}

/**
 * Intrinsic size of a pickable element.
 */
function sourceSize(el) {
    if (el instanceof HTMLImageElement) {
        return el.complete ? [el.naturalWidth, el.naturalHeight] : [0, 0];
    } else if (el instanceof HTMLVideoElement) {
        return [el.videoWidth, el.videoHeight];
    } else if (el instanceof HTMLCanvasElement) {
        return [el.width, el.height];
    }

    return [0, 0];
}

/**
 * Computes where the image is drawn on screen, taking object-fit and object-position into account.
 */
function displayedBox(el, nw, nh) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = name => parseFloat(cs[name]) || 0;

    // Content-box of the element
    const left = px('borderLeftWidth') + px('paddingLeft');
    const top = px('borderTopWidth') + px('paddingTop');
    const w = r.width - left - px('borderRightWidth') - px('paddingRight');
    const h = r.height - top - px('borderBottomWidth') - px('paddingBottom');

    // Videos are letterboxed by default
    const fit = cs.objectFit || (el instanceof HTMLVideoElement ? 'contain' : 'fill');
    let dw = w, dh = h;

    if (fit !== 'fill') {
        const contain = Math.min(w / nw, h / nh);
        const scale = {
            contain,
            cover: Math.max(w / nw, h / nh),
            none: 1,
            'scale-down': Math.min(1, contain)
        }[fit] || contain;

        dw = nw * scale;
        dh = nh * scale;
    }

    // Object position, only percentages and pixels are supported (default is centered)
    const [posX = '50%', posY = '50%'] = (cs.objectPosition || '').split(/\s+/);
    const offset = (v, free) => v.endsWith('%') ? free * parseFloat(v) / 100 : (parseFloat(v) || 0);

    return {
        x: r.left + left + offset(posX, w - dw),
        y: r.top + top + offset(posY, h - dh),
        w: dw,
        h: dh
    };
}

/**
 * Copies the current content of an element into a readable canvas.
 * @returns {CanvasRenderingContext2D|null} null if the element is cross-origin (tainted) or empty.
 */
function snapshot(el) {
    const [w, h] = sourceSize(el);
    if (!w || !h) {
        return null;
    }

    try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext('2d', {willReadFrequently: true});
        ctx.drawImage(el, 0, 0);
        ctx.getImageData(0, 0, 1, 1); // Throws if tainted
        return ctx;
    } catch {
        return null;
    }
}

function pickFromPage(signal, targets) {
    if (signal && signal.aborted) {
        return Promise.reject(abortError());
    }

    const isTarget = typeof targets === 'function' ? targets : el => el.matches(targets);

    return new Promise((resolve, reject) => {
        const dpr = window.devicePixelRatio || 1;
        const snapshots = new Map();

        // Cursor style during selection
        const style = document.createElement('style');
        style.textContent = `
            .${ACTIVE_CLASS}, .${ACTIVE_CLASS} * { cursor: crosshair !important; }
            .${ACTIVE_CLASS}[data-pcr-eyedropper='hover'], .${ACTIVE_CLASS}[data-pcr-eyedropper='hover'] * { cursor: none !important; }
            .${ACTIVE_CLASS}[data-pcr-eyedropper='denied'], .${ACTIVE_CLASS}[data-pcr-eyedropper='denied'] * { cursor: not-allowed !important; }
        `;

        // Magnifier showing the pixels around the cursor
        const loupe = document.createElement('canvas');
        loupe.width = loupe.height = Math.round(LOUPE_SIZE * dpr);
        loupe.style.cssText = `
            position: fixed; top: 0; left: 0; z-index: 2147483647; pointer-events: none; display: none;
            width: ${LOUPE_SIZE}px; height: ${LOUPE_SIZE}px; border-radius: 50%;
            box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), 0 0 0 3px rgba(255, 255, 255, 0.9), 0 2px 10px 3px rgba(0, 0, 0, 0.5);
        `;

        const loupeCtx = loupe.getContext('2d');
        const pixels = document.createElement('canvas');
        pixels.width = pixels.height = LOUPE_PIXELS;
        const pixelsCtx = pixels.getContext('2d');

        const html = document.documentElement;
        document.head.appendChild(style);
        document.body.appendChild(loupe);
        html.classList.add(ACTIVE_CLASS);

        // Element and pixel currently hovered
        let current = null;

        const setCursor = state => state ?
            html.setAttribute('data-pcr-eyedropper', state) :
            html.removeAttribute('data-pcr-eyedropper');

        const locate = (cx, cy) => {
            for (const el of elementsFromPoint(document, cx, cy)) {
                if (el === loupe || !isTarget(el)) {
                    continue;
                }

                // Take a snapshot once per element, videos and canvases might change over time
                if (!snapshots.has(el)) {
                    snapshots.set(el, snapshot(el));
                }

                const ctx = snapshots.get(el);
                if (!ctx) {
                    return {denied: true};
                }

                const {width, height} = ctx.canvas;
                const box = displayedBox(el, width, height);
                const x = Math.floor((cx - box.x) * width / box.w);
                const y = Math.floor((cy - box.y) * height / box.h);

                // Pointer is on the element but outside the image (e.g. letterboxing)
                if (x < 0 || y < 0 || x >= width || y >= height) {
                    continue;
                }

                return {ctx, x, y};
            }

            return null;
        };

        const render = (cx, cy) => {
            if (!current || !current.ctx) {
                loupe.style.display = 'none';
                setCursor(current && current.denied ? 'denied' : null);
                return;
            }

            const {ctx, x, y} = current;
            const half = (LOUPE_PIXELS - 1) / 2;
            setCursor('hover');

            // Pixels outside the image are transparent and appear black
            pixelsCtx.clearRect(0, 0, LOUPE_PIXELS, LOUPE_PIXELS);
            pixelsCtx.putImageData(ctx.getImageData(x - half, y - half, LOUPE_PIXELS, LOUPE_PIXELS), 0, 0);

            loupeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
            loupeCtx.imageSmoothingEnabled = false;
            loupeCtx.fillStyle = '#000';
            loupeCtx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
            loupeCtx.drawImage(pixels, 0, 0, LOUPE_SIZE, LOUPE_SIZE);

            // Pixel grid
            loupeCtx.beginPath();
            for (let i = 1; i < LOUPE_PIXELS; i++) {
                const p = i * LOUPE_ZOOM + 0.5;
                loupeCtx.moveTo(p, 0);
                loupeCtx.lineTo(p, LOUPE_SIZE);
                loupeCtx.moveTo(0, p);
                loupeCtx.lineTo(LOUPE_SIZE, p);
            }
            loupeCtx.lineWidth = 1;
            loupeCtx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
            loupeCtx.stroke();

            // Center pixel, black and white to be visible on any color
            const c = half * LOUPE_ZOOM;
            loupeCtx.strokeStyle = '#000';
            loupeCtx.strokeRect(c - 0.5, c - 0.5, LOUPE_ZOOM + 1, LOUPE_ZOOM + 1);
            loupeCtx.strokeStyle = '#fff';
            loupeCtx.strokeRect(c + 0.5, c + 0.5, LOUPE_ZOOM - 1, LOUPE_ZOOM - 1);

            loupe.style.display = 'block';
            loupe.style.transform = `translate(${cx - LOUPE_SIZE / 2}px, ${cy - LOUPE_SIZE / 2}px)`;
        };

        const update = e => {
            current = locate(e.clientX, e.clientY);
            render(e.clientX, e.clientY);
        };

        // Swallow events so the page (and pickr itself) doesn't react to them during selection
        const swallow = e => {
            e.preventDefault();
            e.stopPropagation();
        };

        const onPointer = e => {
            swallow(e);
            update(e);
        };

        const onClick = e => {
            swallow(e);
            update(e);

            if (current && current.ctx) {
                const [r, g, b] = current.ctx.getImageData(current.x, current.y, 1, 1).data;
                cleanup();
                resolve({sRGBHex: toHex(r, g, b)});
            } else {

                // Clicking anywhere else cancels the selection
                cancel();
            }
        };

        const onKeyDown = e => {
            if (e.key === 'Escape') {
                swallow(e);
                cancel();
            }
        };

        const onContextMenu = e => {
            swallow(e);
            cancel();
        };

        const listeners = [
            ['pointermove', update],
            ['pointerdown', onPointer],
            ['pointerup', swallow],
            ['mousedown', swallow],
            ['mouseup', swallow],
            ['touchstart', swallow],
            ['click', onClick],
            ['contextmenu', onContextMenu],
            ['keydown', onKeyDown]
        ];

        // Hide the magnifier while scrolling, the content below the cursor changes
        const onScroll = () => {
            current = null;
            render();
        };

        const cleanup = () => {
            listeners.forEach(([type, fn]) => window.removeEventListener(type, fn, true));
            window.removeEventListener('scroll', onScroll, true);
            signal && signal.removeEventListener('abort', cancel);
            html.classList.remove(ACTIVE_CLASS);
            setCursor(null);
            style.remove();
            loupe.remove();
        };

        const cancel = () => {
            cleanup();
            reject(abortError());
        };

        listeners.forEach(([type, fn]) => window.addEventListener(type, fn, {capture: true, passive: false}));
        window.addEventListener('scroll', onScroll, {capture: true, passive: true});
        signal && signal.addEventListener('abort', cancel);
    });
}
